# ElasticVue Pro

**Multi-cluster Elasticsearch dashboard for Windows — reaches clusters behind an SSH jump host, decides certificate trust itself, and never writes to a cluster.**

[![build](https://github.com/karthick-dkk/elasticvue-pro-desktop/actions/workflows/build-windows.yml/badge.svg)](https://github.com/karthick-dkk/elasticvue-pro-desktop/actions)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust)
![Windows x64](https://img.shields.io/badge/Windows-x64%20portable-0078D4?logo=windows)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A portable desktop app (Tauri 2 + a small Rust core, vanilla-JS UI, no Node.js) that shows
the health, disk, repositories, ILM/SLM state, last snapshot and daily indices of many
Elasticsearch clusters on one screen — including clusters that are only reachable through a
jump host. Read-only towards Elasticsearch by design.

<p align="center"><img src="docs/screenshots/clusters.png" alt="Clusters overview" width="900"></p>

## Why this exists

Browser tools cannot do three things an operator behind a jump host needs:

| Problem | What ElasticVue Pro does |
|---|---|
| The cluster is only reachable via a jump host | Opens its **own SSH connection** with your key file (`via: jumpwin`) — no ssh.exe, PuTTY or SOCKS setup. Host keys are confirmed once and pinned; the tunnel reconnects by itself. |
| Self-signed / internal-CA certificates | Shows the certificate once (subject, issuer, validity, SHA-256) with a **Trust** button, then pins it. A different certificate at the same address is refused. No CA import, no browser policy. |
| "Failed to fetch" | Every failure is named — refused, DNS, timeout, TLS untrusted, pin mismatch, jump host down — with a one-line next step and, where a decision is needed, the button to take it. |

## Features

- **Clusters** — health, nodes, disk usage, ILM/SLM status, repositories, last snapshot, alerts; fleet tiles and per-cluster charts
- **Indices** — daily `logstash-<client>-YYYY.MM.DD` indices with a client / date picker, sizes, health
- **REST console** — request bar, **Query | Results** side by side, history with favourites (click to load, re-run)
- **Live logs** — tail a day's index with a time histogram
- **Snapshots & SLM** — per repository: snapshots, from/to availability of logstash days, policies and last run
- **Nodes & shards** — heap, CPU, disk per node; unassigned / initializing shards
- **Config in the UI** — add clusters, jump hosts, the shared credential and defaults; saved as `config_cluster.json`
- **Security** — read-only guard in the core; secrets in the file encrypted (AES-256-GCM, PBKDF2-SHA512 master password); optional Windows Credential Manager; TLS pinning; SSH host-key pinning
- **Portable** — one folder, no installer, no admin rights; runs on the analyst PC and on the jump server itself
- **Snapshot mode** — render everything from a JSON file collected elsewhere (esfleet / PowerShell collector) with no network access

<p align="center"><img src="docs/screenshots/rest-console.png" alt="REST console" width="900"></p>

## Quick start (Windows, portable)

1. Download `ElasticVue-Pro-<version>-portable-win64.zip` from [Releases](../../releases) and unzip it anywhere (e.g. `C:\Tools\ElasticVuePro\`). Keep `elasticvue-pro.exe` and `WebView2Loader.dll` together.
2. **Windows Server 2016 only:** the app needs the Microsoft WebView2 runtime, which Server 2016 does not ship. No install is required — unpack Microsoft's *Fixed Version Runtime* into the `WebView2Runtime\` folder next to the exe (see [docs/HANDBOOK.md → Portable mode](docs/HANDBOOK.md#portable-mode-no-install-at-all)). Windows 10/11 and Server 2019+ already have it.
3. Run `elasticvue-pro.exe`. The binaries are not code-signed: on first run SmartScreen may ask — *More info → Run anyway*.
4. **+ Create new config**, add your first cluster, and (for on-prem clusters) a jump host with your SSH key. Confirm the jump host's key fingerprint once, trust each self-signed certificate once.

Everything the app stores stays in `data\` next to the exe (`portable` marker file): `config_cluster.json`, `pins.json` (fingerprints only), the WebView profile.

## Configuration

Created and edited in the app (Config page), or hand-written. JSON is what the app writes; YAML from the browser-extension era is accepted as input.

```json
{
  "version": 2,
  "credentials": { "username": "elastic", "password": "enc:v1:pbkdf2-sha512:600000:<salt>:<nonce>:<ciphertext>" },
  "defaults": { "readOnly": true, "autoRefresh": false, "logIndexPattern": "logstash-*", "tls": "auto" },
  "jump_hosts": {
    "jumpwin": { "host": "jump-windows.internal", "port": 22, "user": "esfleet", "keyFile": "C:\\Users\\me\\.ssh\\id_ed25519" }
  },
  "clusters": [
    { "name": "acme-onprem", "url": "https://172.23.40.118:9200", "via": "jumpwin", "tags": ["onprem"] },
    { "name": "prod-elk",    "url": "https://es-prod-01.internal:9200" },
    { "name": "lab",         "url": "http://192.168.10.25:9200", "tls": "insecure" }
  ]
}
```

| Key | Meaning |
|---|---|
| `credentials` | one credential for every cluster; omit it and the app asks once on start. Per-cluster `username`/`password` override it |
| `password` / `apiKey` / `bearer` | plain, or `enc:v1:…` as written by the app (encrypted with your master password — a hash could not log in) |
| `jump_hosts.<id>` | SSH host, port, user, `keyFile` (OpenSSH format; passphrase is asked in the app, never stored) |
| `clusters[].via` | route through that jump host; the hostname is resolved **on the jump host** |
| `clusters[].tls` / `defaults.tls` | `auto` (OS store, else ask & pin — default), `system` (strict), `insecure` (lab only) |
| `defaults.readOnly` | `true` (default) — the core sends only GET/HEAD and `_search`-family POSTs |

Command line: `elasticvue-pro.exe --config C:\path\config_cluster.json` (or `ELASTICVUE_CONFIG`) pre-provisions the file, handy on a jump server.

<p align="center"><img src="docs/screenshots/config.png" alt="Config page" width="900"></p>

## Building

No Node.js anywhere: the UI is plain ES modules, the CLI is Rust.

**On Windows** — Rust (MSVC) + Visual Studio Build Tools (C++ workload):

```powershell
cargo install tauri-cli --version "^2" --locked
cargo tauri build
# target\release\elasticvue-pro.exe                          portable
# target\release\bundle\nsis\ElasticVue Pro_<ver>_x64-setup.exe   per-user installer
```

**From Linux, without any Microsoft toolchain** — this is how the release zips are made:

```bash
tools/build-windows-cross.sh          # mingw-w64, x86_64-pc-windows-gnu, std built from source; idempotent
# dist/ElasticVue-Pro-<ver>-portable-win64.zip
```


**Run the UI in a browser** (development, tests):

```bash
cargo run -p espro-core --features bridge --bin espro-bridge -- ui 8765   # http://127.0.0.1:8765/
cargo test -p espro-core --features bridge
```

`lab/README.md` shows how to stand up a mock 80-cluster fleet and a restricted local `sshd`
to exercise the jump-host path end to end.

## How it is built

```
crates/espro-core/   Rust core — everything with a security consequence
  guard.rs           read-only guard: GET/HEAD + search-family POST, checked before any socket
  tls.rs             OS trust store → trust-on-first-use pin (SHA-256 per host:port); SSH host-key pins
  ssh.rs             SSH client (russh): key/passphrase/password auth, TOFU host keys, reconnect with back-off
  socks.rs           in-process SOCKS5 on 127.0.0.1 → direct-tcpip channels on the jump host
  http.rs            one HTTP client per cluster (reqwest/rustls), exact error classification
  crypto.rs          AES-256-GCM + PBKDF2-HMAC-SHA512 for secrets in the config file
  vault.rs           OS credential store (Windows Credential Manager) — opt-in
  bridge.rs          the JSON message API the UI talks to
src-tauri/           Tauri 2 shell: one `bridge` command, native dialogs, portable-mode setup
ui/                  the app UI: vanilla ES modules, no bundler
tools/               cross-build script, portable README
docs/                HANDBOOK.md (full operator manual), screenshots
```

The UI never talks to the network. Every request goes through the core, which owns the
read-only guard, the TLS decisions and the tunnels — so no page, console or future code path
can route around them.

## Security

See [SECURITY.md](SECURITY.md). Short version: read-only towards Elasticsearch, credentials
never in plain text on disk, TLS and SSH host keys pinned on explicit consent, loopback-only
listeners, unsigned binaries (verify `SHA256SUMS.txt` or build from source).

## Documentation

- [docs/HANDBOOK.md](docs/HANDBOOK.md) — full operator manual: portable mode, configuration reference, build routes, deployment, what was verified
- [lab/README.md](lab/README.md) — local test bench (mock fleet + restricted sshd)
- [CHANGELOG.md](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. Keep the invariants: no network access from `ui/`, no
new HTTP call site outside `http.rs`, no secret written to disk unencrypted, scripts idempotent.
Run `cargo test -p espro-core --features bridge` and `cargo clippy` before opening a PR.

## License

[MIT](LICENSE)
