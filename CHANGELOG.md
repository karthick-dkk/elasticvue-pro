# Changelog

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
