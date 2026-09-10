//! The one message API the UI uses. Same message types as the extension's service
//! worker (PING / PRIME / FORGET / ES …) plus the desktop-only ones (tunnels, trust
//! decisions, config file, vault).

use crate::guard::Writes;
use crate::http::{ClusterSpec, EsRequest, Route, Transport};
use crate::socks::{self, SocksServer};
use crate::ssh::{JumpSpec, Tunnel};
use crate::tls::{PinStore, TlsMode};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

struct Primed {
    clusters: HashMap<String, ClusterSpec>,
    read_only: bool,
}

struct Route1 {
    tunnel: Arc<Tunnel>,
    socks: SocksServer,
}

pub struct Core {
    pins: Arc<PinStore>,
    transport: Transport,
    primed: RwLock<Primed>,
    tunnels: tokio::sync::RwLock<HashMap<String, Route1>>,
    data_dir: Option<PathBuf>,
    /// `--config <path>` or ELASTICVUE_CONFIG: a config file to offer when none is remembered.
    config_hint: Option<String>,
    /// The operator's write unlock. Session-only on purpose: never written to disk and
    /// never surviving a restart, so the app always starts read-only.
    writes_unlocked: std::sync::atomic::AtomicBool,
    /// When each request left for each cluster, so "how hard are we hitting it" is a
    /// number rather than a guess. Trimmed to the reporting window on every read.
    request_log: parking_lot::Mutex<HashMap<String, std::collections::VecDeque<std::time::Instant>>>,
    started: std::time::Instant,
}

/// The window the request counter reports over.
pub const REQUEST_WINDOW: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// `--config <path>` / `--config=<path>` on the command line, else $ELASTICVUE_CONFIG.
fn config_hint_from_env() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    for (i, a) in args.iter().enumerate() {
        if let Some(v) = a.strip_prefix("--config=") {
            return Some(v.to_string());
        }
        if a == "--config" {
            if let Some(v) = args.get(i + 1) {
                return Some(v.clone());
            }
        }
    }
    std::env::var("ELASTICVUE_CONFIG").ok().filter(|s| !s.trim().is_empty())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimeMsg {
    #[serde(default)]
    clusters: Vec<ClusterSpec>,
    #[serde(default)]
    jump_hosts: Vec<JumpSpec>,
    #[serde(default)]
    read_only: Option<bool>,
}

impl Core {
    /// `data_dir`: where pins.json (and nothing secret) lives. `None` = in-memory only.
    pub fn new(data_dir: Option<PathBuf>) -> Arc<Core> {
        let pins = PinStore::open(data_dir.as_ref().map(|d| d.join("pins.json")));
        Arc::new(Core {
            transport: Transport::new(pins.clone()),
            pins,
            primed: RwLock::new(Primed { clusters: HashMap::new(), read_only: true }),
            tunnels: tokio::sync::RwLock::new(HashMap::new()),
            data_dir,
            config_hint: config_hint_from_env(),
            writes_unlocked: std::sync::atomic::AtomicBool::new(false),
            request_log: parking_lot::Mutex::new(HashMap::new()),
            started: std::time::Instant::now(),
        })
    }

    pub async fn handle(self: &Arc<Self>, msg: Value) -> Value {
        let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "PING" => self.ping().await,
            "PRIME" => self.prime(msg).await,
            "FORGET" => {
                {
                    let mut p = self.primed.write();
                    p.clusters.clear();
                }
                self.set_writes_unlocked(false);
                self.transport.forget_clients();
                self.close_tunnels().await;
                json!({ "ok": true })
            }
            "ES" => self.es(msg).await,
            "TUNNELS" => json!({ "ok": true, "tunnels": self.tunnel_status().await }),
            "TUNNEL_RECONNECT" => {
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("");
                let ts = self.tunnels.read().await;
                match ts.get(id) {
                    Some(r) => {
                        r.tunnel.close().await;
                        r.tunnel.reset_backoff();
                        json!({ "ok": true })
                    }
                    None => json!({ "ok": false, "message": format!("no tunnel {id}") }),
                }
            }
            "TRUST_CERT" => {
                let host = msg.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let fp = msg.get("sha256").and_then(|v| v.as_str()).map(String::from);
                let seen = self.pins.last_seen(&host);
                match (fp.or(seen.as_ref().map(|c| c.sha256.clone())), seen) {
                    (Some(fp), seen) => {
                        self.pins.trust_cert(&host, &fp, seen.as_ref().map(|c| c.subject.as_str()).unwrap_or(""));
                        self.transport.forget_clients();
                        json!({ "ok": true, "host": host, "sha256": fp })
                    }
                    _ => json!({ "ok": false, "message": "no certificate has been seen for that host yet" }),
                }
            }
            "UNTRUST_CERT" => {
                let host = msg.get("host").and_then(|v| v.as_str()).unwrap_or("");
                self.pins.untrust_cert(host);
                self.transport.forget_clients();
                json!({ "ok": true })
            }
            "TRUST_HOSTKEY" => {
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let ts = self.tunnels.read().await;
                let Some(r) = ts.get(&id) else { return json!({ "ok": false, "message": format!("no tunnel {id}") }) };
                let Some((fp, kt)) = r.tunnel.offered_hostkey() else {
                    return json!({ "ok": false, "message": "the jump host has not presented a key yet" });
                };
                if let Some(want) = msg.get("fingerprint").and_then(|v| v.as_str()) {
                    if want != fp {
                        return json!({ "ok": false, "message": "fingerprint no longer matches what the host offers" });
                    }
                }
                self.pins.trust_hostkey(&id, &fp, &kt);
                r.tunnel.reset_backoff();
                json!({ "ok": true, "jumpId": id, "fingerprint": fp, "keyType": kt })
            }
            "UNTRUST_HOSTKEY" => {
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("");
                self.pins.untrust_hostkey(id);
                if let Some(r) = self.tunnels.read().await.get(id) {
                    r.tunnel.close().await;
                    r.tunnel.reset_backoff();
                }
                json!({ "ok": true })
            }
            "TUNNEL_SECRET" => {
                // passphrase / password for a jump host, session only
                let id = msg.get("jumpId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let passphrase = msg.get("passphrase").and_then(|v| v.as_str()).map(String::from);
                let password = msg.get("password").and_then(|v| v.as_str()).map(String::from);
                let mut ts = self.tunnels.write().await;
                let Some(old) = ts.remove(&id) else { return json!({ "ok": false, "message": format!("no tunnel {id}") }) };
                old.tunnel.close().await;
                let mut spec = old.tunnel.spec.clone();
                if passphrase.is_some() {
                    spec.passphrase = passphrase;
                }
                if password.is_some() {
                    spec.password = password;
                }
                drop(old);
                match self.make_route(spec).await {
                    Ok(r) => {
                        ts.insert(id, r);
                        self.transport.forget_clients();
                        json!({ "ok": true })
                    }
                    Err(e) => json!({ "ok": false, "message": e }),
                }
            }
            // The operator's write unlock, for actions taken by hand in the UI. Held in
            // memory for this session only; a request must still ask for it per-request
            // (`allowWrites`), so nothing that polls in the background can write while
            // it is on.
            "WRITE_UNLOCK" => {
                let on = msg.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                self.set_writes_unlocked(on);
                json!({ "ok": true, "writesUnlocked": on })
            }
            // How many requests this app has sent to each cluster lately — the answer to
            // "are we stressing Elasticsearch", as a number.
            "REQUEST_STATS" => json!({ "ok": true, "requests": self.request_stats() }),
            "PINS" => json!({ "ok": true, "pins": self.pins.list() }),
            "CONFIG_READ" => {
                let path = msg.get("path").and_then(|v| v.as_str()).unwrap_or("");
                match tokio::fs::read_to_string(path).await {
                    Ok(text) => {
                        let meta = tokio::fs::metadata(path).await.ok();
                        json!({ "ok": true, "path": path, "text": text,
                                "size": meta.as_ref().map(|m| m.len()),
                                "lastModified": meta.and_then(|m| m.modified().ok())
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64) })
                    }
                    Err(e) => json!({ "ok": false, "message": format!("cannot read {path}: {e}") }),
                }
            }
            "FILE_WRITE" | "CONFIG_WRITE" | "CONFIG_WRITE_EXAMPLE" => {
                // atomic: write .tmp then rename; private permissions where the OS has them
                let path = msg.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if path.is_empty() {
                    return json!({ "ok": false, "message": "no path" });
                }
                let p = std::path::PathBuf::from(path);
                let tmp = p.with_extension("tmp");
                if let Some(dir) = p.parent() {
                    let _ = tokio::fs::create_dir_all(dir).await;
                }
                if let Err(e) = tokio::fs::write(&tmp, text).await {
                    return json!({ "ok": false, "message": format!("cannot write {}: {e}", tmp.display()) });
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
                }
                match tokio::fs::rename(&tmp, &p).await {
                    Ok(_) => json!({ "ok": true, "path": path, "bytes": text.len() }),
                    Err(e) => json!({ "ok": false, "message": format!("cannot replace {path}: {e}") }),
                }
            }
            "SEAL" => {
                let plain = msg.get("plain").and_then(|v| v.as_str()).unwrap_or("");
                let master = msg.get("master").and_then(|v| v.as_str()).unwrap_or("");
                match crate::crypto::seal(plain, master) {
                    Ok(v) => json!({ "ok": true, "value": v }),
                    Err(e) => json!({ "ok": false, "message": e }),
                }
            }
            "OPEN" => {
                let value = msg.get("value").and_then(|v| v.as_str()).unwrap_or("");
                let master = msg.get("master").and_then(|v| v.as_str()).unwrap_or("");
                match crate::crypto::open(value, master) {
                    Ok(p) => json!({ "ok": true, "plain": p }),
                    Err(crate::crypto::OpenError::WrongMaster) => json!({ "ok": false, "kind": "bad_master", "message": "master password not accepted" }),
                    Err(crate::crypto::OpenError::NotSealed) => json!({ "ok": true, "plain": value, "unsealed": true }),
                    Err(_) => json!({ "ok": false, "kind": "malformed", "message": "the encrypted value is malformed" }),
                }
            }
            #[cfg(feature = "vault")]
            "VAULT_GET" | "VAULT_SET" | "VAULT_DEL" => crate::vault::handle(t, &msg),
            "ENABLE_NET_ERRORS" => json!({ "ok": true, "always": true }),
            "BADGE" | "OPEN_APP" => json!({ "ok": true }),
            _ => json!({ "ok": false, "kind": "bad_message", "message": format!("Unknown message type {t:?}") }),
        }
    }

    fn record_request(&self, cluster: &str) {
        let mut log = self.request_log.lock();
        let q = log.entry(cluster.to_string()).or_default();
        q.push_back(std::time::Instant::now());
        // Keep the queue bounded even for a very chatty cluster.
        while q.len() > 10_000 {
            q.pop_front();
        }
    }

    /// Requests sent to each cluster in the last `REQUEST_WINDOW`, plus the rate that
    /// implies. Old entries are dropped as they age out, so memory stays flat.
    pub fn request_stats(&self) -> Value {
        let now = std::time::Instant::now();
        let mut log = self.request_log.lock();
        let mut out = serde_json::Map::new();
        for (cluster, q) in log.iter_mut() {
            while q.front().map(|t| now.duration_since(*t) > REQUEST_WINDOW).unwrap_or(false) {
                q.pop_front();
            }
            let n = q.len();
            let secs = REQUEST_WINDOW.as_secs_f64();
            out.insert(cluster.clone(), json!({
                "last5m": n,
                "perMinute": (n as f64) / (secs / 60.0),
                "perSecond": (n as f64) / secs,
            }));
        }
        json!({ "windowSec": REQUEST_WINDOW.as_secs(), "clusters": out })
    }

    pub fn writes_unlocked(&self) -> bool {
        self.writes_unlocked.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn set_writes_unlocked(&self, on: bool) {
        self.writes_unlocked.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    async fn ping(self: &Arc<Self>) -> Value {
        let (primed, read_only, ids) = {
            let p = self.primed.read();
            (!p.clusters.is_empty(), p.read_only, p.clusters.keys().cloned().collect::<Vec<_>>())
        };
        json!({
            "ok": true, "primed": primed, "readOnly": read_only, "version": crate::VERSION,
            "writesUnlocked": self.writes_unlocked(),
            "requests": self.request_stats(),
            "desktop": true, "netErrors": true, "clusters": ids,
            "vault": cfg!(feature = "vault"),
            "dataDir": self.data_dir, "configHint": self.config_hint, "uptimeSec": self.started.elapsed().as_secs(),
            "defaultConfigPath": self.data_dir.as_ref().map(|d| d.join("config_cluster.json")),
            "tunnels": self.tunnel_status().await,
        })
    }

    async fn tunnel_status(&self) -> Vec<Value> {
        let ts = self.tunnels.read().await;
        let mut v: Vec<Value> = ts.values().map(|r| r.tunnel.status_json(Some(r.socks.port))).collect();
        v.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        v
    }

    async fn make_route(self: &Arc<Self>, spec: JumpSpec) -> Result<Route1, String> {
        let tunnel = Tunnel::new(spec, self.pins.clone());
        let socks = socks::start(tunnel.clone()).await.map_err(|e| format!("socks listener: {e}"))?;
        Ok(Route1 { tunnel, socks })
    }

    async fn close_tunnels(self: &Arc<Self>) {
        let mut ts = self.tunnels.write().await;
        for (_, r) in ts.drain() {
            r.tunnel.close().await;
        }
    }

    async fn prime(self: &Arc<Self>, msg: Value) -> Value {
        let p: PrimeMsg = match serde_json::from_value(msg) {
            Ok(p) => p,
            Err(e) => return json!({ "ok": false, "message": format!("bad PRIME: {e}") }),
        };
        {
            let mut cur = self.primed.write();
            cur.clusters = p.clusters.into_iter().map(|c| (c.id.clone(), c)).collect();
            cur.read_only = p.read_only != Some(false);
        }
        self.transport.forget_clients();

        // Keep tunnels whose spec is unchanged (a live SSH session is worth keeping);
        // replace the rest. Session secrets (passphrase/password) survive a re-prime
        // that does not carry them.
        let mut ts = self.tunnels.write().await;
        let mut keep: HashMap<String, Route1> = HashMap::new();
        for mut spec in p.jump_hosts {
            if let Some(old) = ts.remove(&spec.id) {
                let o = &old.tunnel.spec;
                if spec.passphrase.is_none() {
                    spec.passphrase = o.passphrase.clone();
                }
                if spec.password.is_none() {
                    spec.password = o.password.clone();
                }
                if o.host == spec.host && o.port == spec.port && o.user == spec.user && o.key_file == spec.key_file
                    && o.passphrase == spec.passphrase && o.password == spec.password
                {
                    keep.insert(spec.id.clone(), old);
                    continue;
                }
                old.tunnel.close().await;
            }
            match self.make_route(spec.clone()).await {
                Ok(r) => {
                    keep.insert(spec.id.clone(), r);
                }
                Err(e) => tracing::error!("jump host {}: {e}", spec.id),
            }
        }
        for (_, r) in ts.drain() {
            r.tunnel.close().await;
        }
        *ts = keep;
        let n_t = ts.len();
        drop(ts);
        let p = self.primed.read();
        json!({ "ok": true, "count": p.clusters.len(), "readOnly": p.read_only, "tunnels": n_t })
    }

    async fn es(self: &Arc<Self>, msg: Value) -> Value {
        let req: EsRequest = match serde_json::from_value(msg) {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "kind": "bad_message", "message": format!("bad ES request: {e}") }),
        };
        let (spec, read_only) = {
            let p = self.primed.read();
            (p.clusters.get(&req.cluster_id).cloned(), p.read_only)
        };
        // Like the extension: an explicit authHeader in the request wins (diagnostic
        // probes send "" for "no credential"); otherwise the primed one; none = re-prime.
        let (auth, url, via, tls) = match (&req.auth_header, &spec) {
            (Some(a), Some(s)) => (Some(a.clone()), req.url.clone().unwrap_or(s.url.clone()), s.via.clone(), s.tls.clone()),
            (Some(a), None) => (Some(a.clone()), req.url.clone().unwrap_or_default(), None, None),
            (None, Some(s)) => (s.auth_header.clone(), req.url.clone().unwrap_or(s.url.clone()), s.via.clone(), s.tls.clone()),
            (None, None) => return json!({ "ok": false, "kind": "no_creds", "message": "Not primed; re-priming." }),
        };
        if url.is_empty() {
            return json!({ "ok": false, "kind": "bad_message", "message": "no url" });
        }
        let ts = self.tunnels.read().await;
        let tunnel = match via.as_deref().filter(|v| !v.is_empty()) {
            Some(id) => match ts.get(id) {
                Some(r) => Some((&r.tunnel, r.socks.port)),
                None => {
                    return json!({ "ok": false, "status": 0, "kind": "tunnel_error", "tunnelKind": "missing",
                                   "message": format!("cluster routes via jump host {id:?}, which is not defined under jump_hosts: in clusters.yaml"),
                                   "url": url })
                }
            },
            None => None,
        };
        let route = Route { tunnel, tls: TlsMode::parse(tls.as_deref()) };
        let writes = Writes::decide(read_only, self.writes_unlocked(), req.allow_writes);
        let out = self.transport.request(&req, &url, auth.as_deref(), writes, route).await;
        // Only requests that actually went to the cluster count as load on it.
        if out.get("kind").and_then(|k| k.as_str()) != Some("blocked_readonly") {
            self.record_request(&req.cluster_id);
        }
        out
    }
}
