//! HTTP bridge: serves the UI folder and exposes the core's message API at POST /bridge,
//! so the whole app runs in a normal browser without a WebView.
//!
//! Two modes, and the difference matters:
//!
//! * **Development** (default): binds loopback, no authentication. One person, one
//!   machine, nothing else can reach it.
//! * **Hosted** (`ESPRO_BIND` set to a non-loopback address): meant to sit behind a
//!   reverse proxy that authenticates and forwards the user's name in `X-Auth-User`.
//!   The bridge refuses any request without that header, and records the name on every
//!   write it performs. It never sees a password — that is the proxy's job.
//!
//! The header is trusted, so the bridge must not be reachable except through the proxy.
//! Binding it to anything other than loopback without one in front is an open
//! Elasticsearch admin console with your stored credentials.

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use espro_core::auth::{Caller, Edition};
use espro_core::Core;
use std::sync::Arc;
use tower_http::services::ServeDir;

/// The header a trusted proxy sets after authenticating the user.
pub const USER_HEADER: &str = "x-auth-user";

/// Message types that change something and are therefore audited by user.
const AUDITED: &[&str] = &["ES", "WRITE_UNLOCK", "TRUST_CERT", "UNTRUST_CERT", "TRUST_HOSTKEY",
                           "UNTRUST_HOSTKEY", "CONFIG_WRITE", "FILE_WRITE", "FORGET"];

struct App {
    core: Arc<Core>,
    /// Hosted mode: an authenticated user name is required on every request.
    require_user: bool,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let ui = std::env::args().nth(1).unwrap_or_else(|| "ui".into());
    let port: u16 = std::env::args().nth(2).and_then(|p| p.parse().ok()).unwrap_or(8765);
    let data = std::env::var("ESPRO_DATA_DIR").ok().map(std::path::PathBuf::from);

    // Loopback unless told otherwise. A non-loopback bind switches on the user requirement.
    let bind: std::net::IpAddr = std::env::var("ESPRO_BIND").ok()
        .and_then(|b| b.parse().ok())
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));
    let require_user = !bind.is_loopback();
    if require_user {
        tracing::warn!(bind = %bind, "hosted mode: every request must carry {USER_HEADER} from an authenticating proxy");
    }

    // The dev bridge on loopback is a single person on their own machine, exactly like
    // the portable build; a non-loopback bind is the hosted deployment.
    let edition = if require_user { Edition::Hosted } else { Edition::Portable };
    let core = Core::new(data, edition);
    let app = Router::new()
        .route("/bridge", post(bridge))
        .fallback_service(ServeDir::new(&ui))
        .with_state(Arc::new(App { core, require_user }));
    let addr = std::net::SocketAddr::from((bind, port));
    println!("espro-bridge: http://{addr}/  (ui from {ui}){}", if require_user { "  [hosted: user header required]" } else { "" });
    let l = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(l, app).await.expect("serve");
}

async fn bridge(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(msg): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let user = headers.get(USER_HEADER).and_then(|v| v.to_str().ok()).map(str::trim).filter(|u| !u.is_empty());

    // An API token stands on its own: it is a secret this core issued and can revoke, so
    // unlike the user header it does not need the proxy to have vouched for anything.
    // That is what lets Zabbix and scripts in without an account or a password.
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty());

    if app.require_user && user.is_none() && bearer.is_none() {
        return Json(serde_json::json!({
            "ok": false, "kind": "unauthenticated",
            "message": format!("hosted mode: no {USER_HEADER} header and no bearer token — requests must come through the authenticating proxy, or carry an API token"),
        }));
    }

    // Three ways to be somebody here, most explicit first.
    //
    // An API token is a deliberate act: something presenting one is asking to be that
    // token, not whoever's proxy session it travelled on. A session token is next — it
    // means a person signed in through the app itself, which is a stronger statement than
    // the ambient identity nginx attaches to every request. The proxy header is the
    // fallback, and the only one available to a browser that has never seen a login
    // screen, which is every hosted browser today.
    let caller: Option<Caller> = match bearer {
        Some(secret) => match app.core.caller_for_token(secret) {
            Some(c) => Some(c),
            None => {
                return Json(serde_json::json!({
                    "ok": false, "kind": "unauthenticated",
                    "message": "that API token is not valid, has expired, or has been revoked",
                }))
            }
        },
        None => msg
            .get("session")
            .and_then(|v| v.as_str())
            .and_then(|s| app.core.caller_for_session(s))
            .or_else(|| user.and_then(|u| app.core.caller_for_proxy_user(u))),
    };

    let t = msg.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let out = app.core.handle_as(msg.clone(), caller.clone()).await;

    // The audit line: who did what to which cluster, and whether it went through. This
    // is the record that answers "who deleted that index".
    if AUDITED.contains(&t.as_str()) {
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let is_read = t == "ES" && (method.is_empty() || method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD"));
        if !is_read {
            tracing::info!(
                target: "audit",
                // The resolved caller, so a write made with an API token is attributed to
                // the token rather than to whoever's proxy session it rode in on.
                user = caller.as_ref().map(|c| c.name.as_str()).or(user).unwrap_or("-"),
                role = caller.as_ref().map(|c| c.role.as_str()).unwrap_or("-"),
                msg_type = %t,
                cluster = msg.get("clusterId").and_then(|v| v.as_str()).unwrap_or("-"),
                method = method,
                path = msg.get("path").and_then(|v| v.as_str()).unwrap_or(""),
                ok = out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                kind = out.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
                "write"
            );
        }
    }
    Json(out)
}
