//! Development / test bridge: serves the UI folder over HTTP and exposes the core's
//! message API at POST /bridge, so the whole app can be driven in a normal browser
//! (and by Playwright) without a WebView. Loopback only. Not for production use.

use axum::{extract::State, routing::post, Json, Router};
use espro_core::Core;
use std::sync::Arc;
use tower_http::services::ServeDir;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let ui = std::env::args().nth(1).unwrap_or_else(|| "ui".into());
    let port: u16 = std::env::args().nth(2).and_then(|p| p.parse().ok()).unwrap_or(8765);
    let data = std::env::var("ESPRO_DATA_DIR").ok().map(std::path::PathBuf::from);
    let core = Core::new(data);
    let app = Router::new()
        .route("/bridge", post(bridge))
        .fallback_service(ServeDir::new(&ui))
        .with_state(core);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    println!("espro-bridge: http://{addr}/  (ui from {ui})");
    let l = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(l, app).await.expect("serve");
}

async fn bridge(State(core): State<Arc<Core>>, Json(msg): Json<serde_json::Value>) -> Json<serde_json::Value> {
    Json(core.handle(msg).await)
}
