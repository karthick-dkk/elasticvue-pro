# Changelog

## Unreleased
- **REST console: every method.** GET, HEAD, POST, PUT, PATCH and DELETE are always listed —
  this is the page where a person types the request. Sending a write needs *Allow writes*,
  a session-only unlock held in the core (never on disk, gone on restart) that covers only
  requests typed on that page; background refreshes stay read-only, and destructive requests
  are confirmed by name before they go out.
- Fixed: `_msearch` and `_bulk` were sent as `application/json` because the content type was
  picked by sniffing the body's first character, and those bodies open with a `{` header
  line. Elasticsearch refuses that. The endpoint now decides.
- Continuous integration: `ci.yml` (core tests, clippy, UI checks, dependency advisories) and
  `build-windows.yml` (portable zip on every push, NSIS installer and release assets on a tag).
  The README's build badge pointed at a repository that does not exist.
- Test suite grown from 6 unit tests to 59, including the bridge message API, the transport's
  error classification, and the certificate trust flow — trust-on-first-use, pin mismatch and
  rotation recovery — against real sockets and a real TLS handshake.
- `tools/check-ui.mjs`: parses every UI module and resolves each named import. The UI has no
  bundler, so a mistyped import used to surface as a blank page.
- Added `.gitignore` (build output, operator config, runtime data).

## 2.1.0 — 2026-09-08
- Clusters, jump hosts, the shared credential and defaults can be created and edited in the UI.
- Config is written as `config_cluster.json`; YAML (the extension's `clusters.yaml`) is still read.
- Secrets in the file are encrypted: AES-256-GCM, key from a master password (PBKDF2-HMAC-SHA512, 600k rounds).
- REST console redesigned: request bar, Query | Results side by side, history table below.
- Side panel shows one status row per jump-host tunnel.

## 2.0.0 — 2026-09-08
- First desktop release (Tauri 2 + Rust core), rebuilt from the ElasticVue Pro browser extension.
- Built-in SSH client for clusters behind a jump host (`via:`), host-key trust-on-first-use, auto-reconnect.
- Certificate trust decided in the app (SHA-256 pin per address); exact connection errors.
- Read-only guard in the core; optional Windows Credential Manager storage for the credential.
- Portable mode: `portable` marker keeps all data beside the exe; `WebView2Runtime\` folder for the Fixed Version runtime.
