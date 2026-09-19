//! HTTP bridge: serves the UI folder and exposes the core's message API at POST /bridge,
//! so the whole app runs in a normal browser without a WebView.
//!
//! Two modes, and the difference matters:
//!
//! * **Development** (default): binds loopback, no authentication. One person, one
//!   machine, nothing else can reach it.
//! * **Hosted** (`ESPRO_BIND` set to a non-loopback address): accounts apply, and the
//!   core authenticates people itself — a first administrator is created on first run and
//!   everyone signs in against `users.json`. An API token identifies a machine.
//!
//! A reverse proxy may still authenticate at the edge and pass a name in `X-Auth-User`.
//! That header is trusted, so it is only as good as the proxy in front of it, and it is
//! now only one of three ways to be somebody rather than the only one — it grants
//! whatever role that name has an account for, and nothing at all if it has none.

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
    let hosted = !bind.is_loopback();
    if hosted {
        tracing::warn!(bind = %bind, "hosted mode: accounts required — the first run asks for an administrator");
    }

    // The dev bridge on loopback is a single person on their own machine, exactly like
    // the portable build; a non-loopback bind is the hosted deployment.
    let edition = if hosted { Edition::Hosted } else { Edition::Portable };
    let core = Core::new(data, edition);
    // The one timer in the product. It is started here, inside the runtime and only for
    // the hosted binary, rather than in Core::new — a scheduler that starts itself
    // wherever a Core is built would run in the desktop app and in every test.
    core.start_delay_sink();
    let app = Router::new()
        .route("/bridge", post(bridge))
        .fallback_service(ServeDir::new(&ui))
        .with_state(Arc::new(App { core }));
    let addr = std::net::SocketAddr::from((bind, port));
    println!("espro-bridge: http://{addr}/  (ui from {ui}){}", if hosted { "  [hosted: accounts required]" } else { "" });
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

    // No blanket rejection for a request carrying no header.
    //
    // There used to be one, from when the proxy was the only thing that could identify
    // anybody. The core authenticates people itself now, and that rejection fired before
    // the session was even looked at — so with nginx's basic auth removed the login
    // screen could never have called LOGIN, and the app could never have let anyone in.
    //
    // Nothing is lost by dropping it: every message that needs a role goes through
    // `gate()`, which refuses an unidentified caller with the same "unauthenticated".
    // What is left open is exactly the handful that must be — PING, WHOAMI, LOGIN — which
    // is what a sign-in screen is made of.

    // Three ways to be somebody here, most explicit first.
    //
    // An API token is a deliberate act: something presenting one is asking to be that
    // token, not whoever's proxy session it travelled on. A session token is next — it
    // means a person signed in through the app itself, which is a stronger statement than
    // the ambient identity a proxy attaches to every request. The proxy header is the
    // fallback, for a deployment that still authenticates at the edge.
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
