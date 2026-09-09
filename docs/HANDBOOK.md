# ElasticVue Pro — Windows desktop app

| | |
|---|---|
| **Title** | ElasticVue Pro desktop (Tauri) — multi-cluster Elasticsearch dashboard with jump-host support |
| **Description** | The ElasticVue Pro browser extension rebuilt as a portable Windows application. Same pages and features; plus its own SSH client for clusters behind a jump host, certificate trust decisions made in the app, and an OS-vault option for the credential. Read-only towards Elasticsearch. |
| **Date Published** | 2026-09-08 |
| **Published By** | Karthick |
| **Tags** | elasticsearch, tauri, rust, windows, jump-host, ssh, tls-pinning, read-only |

## Summary

Everything the extension needed a browser for is now done by a small Rust core inside the
app, and the three things a browser could never do are the reason for the rewrite:

1. **Jump hosts.** A cluster marked `via: <jump>` in `clusters.yaml` is reached through an
   SSH connection the app opens itself with your key file — what `ssh -D` does, without
   ssh.exe, PuTTY or a SOCKS proxy to set up. Host keys are confirmed once and pinned.
   The connection reconnects by itself when the jump host drops it.
2. **Certificates you decide about.** A self-signed or internal-CA certificate the OS does
   not trust is shown to you once (subject, issuer, validity, SHA-256) with a *Trust* button.
   Accepting pins that exact certificate for that address; a different one later is refused
   and reported. No CA import, no browser policy, no click-through that does not apply.
3. **Exact errors.** Connection refused, DNS, timeout, TLS untrusted, pin mismatch, jump
   host down — each is named, with a one-line next step, instead of "Failed to fetch".

The read-only guard moved with it: the core sends GET/HEAD and search-family POSTs only,
whatever any page asks for, unless `readOnly: false` is set in the file.

Runs on the analyst workstation (tunnels to the jump host) **and** on the Windows jump
server itself (clusters direct, `via:` omitted) — same build, same YAML format.

## What is in the box

```
espro-desktop/
├── crates/espro-core/     Rust core: read-only guard, TLS pinning, SSH tunnels + SOCKS, HTTP, vault, message bridge
│   └── src/bin/bridge.rs  dev bridge: serves ui/ over HTTP and exposes the core — run the app in a browser for tests
├── src-tauri/             Tauri 2 shell: one `bridge` command, dialogs, icons, tauri.conf.json, capabilities
├── ui/                    the app UI (vanilla ES modules — the extension's pages, transport swapped)
├── lab/                   example clusters.yaml files used by the tests
└── .github/workflows/     CI: core tests on Linux, portable .exe + NSIS installer on Windows
```

Pages and features carried over: Clusters overview (disk, repo, ILM/SLM, last snapshot,
alerts), Indices with client/date picker, Live logs by day, Snapshots & SLM (from/to
availability), Nodes & shards, Config; auto-refresh off by default; one credential for all
URLs with a first-start prompt; snapshot-file mode. New in 2.1: clusters, jump hosts,
credentials and defaults are created and edited in the UI and saved as JSON with encrypted
secrets; the REST console is a request bar with **Query | Results** side by side and the
history table below (click a row to load, *Run* to re-run).

## Configuration — from the UI, or a file

Everything can be created and changed **in the app** (Config page: *+ Add cluster*, *+ Add
jump host*, *Store in config file (encrypted)…*, *Edit defaults…*; setup screen: *+ Create
new config*). The app writes `config_cluster.json` — in portable mode next to the exe under
`data\`, otherwise under `%APPDATA%`. A YAML file from the extension still opens unchanged;
the first edit from the UI is saved as `config_cluster.json` beside it.

**Secrets in the file are encrypted, not hashed.** A hash (SHA-512 or any other) cannot be
used to log in — Elasticsearch needs the real password on every request — so the file holds
`enc:v1:pbkdf2-sha512:…`: the password sealed with AES-256-GCM under a key derived from a
master password with PBKDF2-HMAC-SHA512 (600 000 rounds, random salt and nonce). The master
password is asked for on start (once per session) and never written anywhere; a wrong one is
rejected cleanly. Tick *Remember on this machine* in the sign-in dialog to skip the prompt
(the credential then lives in the Windows Credential Manager).

```json
{
  "version": 2,
  "credentials": { "username": "elastic", "password": "enc:v1:pbkdf2-sha512:600000:<salt>:<nonce>:<ciphertext>" },
  "defaults": { "readOnly": true, "autoRefresh": false, "logIndexPattern": "logstash-*", "tls": "auto" },
  "jump_hosts": { "jumpwin": { "host": "jump-windows.internal", "port": 22, "user": "esfleet", "keyFile": "C:\\Users\\me\\.ssh\\id_ed25519" } },
  "clusters": [
    { "name": "acme-onprem", "url": "https://172.23.40.118:9200", "via": "jumpwin" },
    { "name": "prod-elk", "url": "https://es-prod-01.internal:9200" }
  ]
}
```

The same keys in YAML (the extension's format) are accepted as input:

```yaml
credentials: { username: elastic, password: "…" }     # or omit → the app asks once

jump_hosts:
  jumpwin:
    host: jump-windows.internal
    port: 22
    user: esfleet
    keyFile: C:\Users\me\.ssh\id_ed25519       # OpenSSH format; passphrase is asked for, never stored here

clusters:
  - { name: acme-onprem, url: "https://172.23.40.118:9200", via: jumpwin }   # through the jump host
  - { name: prod-elk,    url: "https://es-prod-01.internal:9200" }           # direct
  - { name: lab,         url: "http://192.168.10.25:9200", tls: insecure }
```

`tls:` per cluster (or under `defaults:`): `auto` (default — OS store, else ask once and pin),
`system` (OS store only, strict), `insecure` (lab only). Names of `via:` clusters are resolved
**on the jump host** (`socks5h` semantics), so use the address the jump host knows.

The app remembers the file's *path* (and `--config <path>` / `ELASTICVUE_CONFIG` pre-provisions
one, e.g. on the jump server). Contents are re-read on every start and on window focus when
the file changed.

## Steps to build

No Node.js is involved. Rust + the Tauri CLI, on Windows:

```powershell
# 1. Rust (MSVC toolchain) — https://rustup.rs ; and "Desktop development with C++" from
#    Visual Studio Build Tools (the linker). WebView2 Runtime is part of Windows 10/11 and
#    Server 2019+; on Windows Server 2016 install it once (Evergreen bootstrapper).
cargo install tauri-cli --version "^2" --locked
# 2. Build
cargo tauri build
#    portable:  target\release\elasticvue-pro.exe          (single file; needs the WebView2 Runtime on the box)
#               packaged as elasticvue-pro-<version>.exe by tools/build-windows-cross.sh
#    installer: target\release\bundle\nsis\ElasticVue Pro_<ver>_x64-setup.exe  (per-user, embeds the WebView2 bootstrapper)
```

Or push to GitHub: `.github/workflows/build-windows.yml` produces both as artifacts and
attaches them to `v*` tag releases.

**Or cross-compile from Linux with no Microsoft toolchain** — `tools/build-windows-cross.sh`
(Ubuntu 24.04: mingw-w64 linker, `x86_64-pc-windows-gnu` target, std built from source with
`-Zbuild-std`, idempotent). Output: `dist/ElasticVue-Pro-<ver>-portable-win64.zip` containing
`elasticvue-pro-<version>.exe` + `WebView2Loader.dll` (this build loads the WebView2 loader dynamically,
so the DLL must stay next to the exe) + the example YAML. This is how the shipped portable
zip was produced; its core binary was exercised under Wine (SSH tunnel, TLS pinning, guard,
Credential Manager) — the WebView2 UI itself needs real Windows.

Linux/macOS builds work the same (`cargo tauri build`) with the platform's WebKit
dependencies; the Linux build was used to run the full app under Xvfb in the tests below.

## Portable mode (no install at all)

The portable zip carries a `portable` marker file: with it present, everything the app
stores — `pins.json`, the WebView profile, the remembered config path — lives in `data\`
next to the exe, and the only external need, the WebView2 runtime, can be satisfied by
unpacking Microsoft's **Fixed Version Runtime** (a plain folder, no installer, no admin)
into `WebView2Runtime\` beside the exe. The app sets `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`
and `WEBVIEW2_USER_DATA_FOLDER` itself before the WebView is created. Windows 10/11 and
Server 2019+ have WebView2 system-wide already; Windows Server 2016 needs the folder.
Delete the marker to go back to per-user storage under `%APPDATA%`.

## Steps to deploy

1. Put `elasticvue-pro-<version>.exe` anywhere (no admin rights needed) — or run the installer.
2. Create `clusters.yaml` (Config page → *Save example YAML…*), keep it readable only by you.
3. Start the app, *Open clusters.yaml…*. For each jump host: confirm the host-key fingerprint
   once (compare with `ssh-keygen -lf` on the jump host). For each cluster with an untrusted
   certificate: *Trust this certificate* once. Both decisions land in
   `%APPDATA%\io.elasticvuepro.desktop\pins.json` — fingerprints only.
4. Optional: tick *Remember on this machine* in the sign-in dialog to keep the credential in
   the Windows Credential Manager (your account only) instead of typing it each start.

On the jump server itself: same exe, `clusters.yaml` without `via:`, optionally started as
`elasticvue-pro-<version>.exe --config C:\esfleet\clusters.yaml`.

## Security model

| | |
|---|---|
| Elasticsearch writes | while `readOnly: true` (default) the core refuses anything but GET/HEAD and `_search`-family POSTs, before opening a socket. Two deliberate acts lift it: `readOnly: false` in the config (everywhere), or ticking *Allow writes* — a session-only unlock, held in memory, that applies **only** to actions the operator takes by hand (a console request, a snapshot, an index action). Background refreshes stay read-only either way |
| Credential | in the app process; optionally in the OS vault (opt-in). Never in `pins.json`, never in logs. The YAML is the only file that may hold it |
| Jump host | your SSH key (OpenSSH format, optional passphrase — asked in the app) or a session password; host key TOFU + pin; `permitopen`-restricted keys (esfleet DEPLOY.md §2/§3) are enough — the app only forwards to the cluster ports |
| TLS | rustls; OS trust store + Mozilla roots; per-address SHA-256 pin on explicit consent; pin mismatch → credential not sent |
| SOCKS listener | loopback only, ephemeral port, accepts loopback peers only, CONNECT only — nothing else on the machine is told about it |
| Data written by the app | `pins.json`, the remembered config path, theme, console history |

## Verified (what the tests actually exercised)

Against a local restricted `sshd` (`restrict,port-forwarding,permitopen="*:9470"`) and the
80-cluster mock fleet from esfleet:

- unknown host key → prompt → trust → tunnel up; key mismatch refused; ed25519 and RSA keys
  (RSA signed with SHA-512, as OpenSSH 8.8+ requires); encrypted key → passphrase prompt →
  wrong passphrase reported as such → right one connects
- SSH session killed server-side → next request reconnects transparently (~100 ms);
  sshd stopped → clear "cannot reach jump host … connection refused" → recovers when back
- `permitopen` refusal reported as a forward error, other clusters unaffected
- certificate untrusted → prompt → trust → OK; server certificate rotated → pin mismatch,
  credential not sent; untrust + trust new → OK; `tls: system` strict fails, `insecure` passes
- read-only guard: DELETE/PUT/other POST blocked, `_search` POST allowed; 20 concurrent
  requests through one tunnel in 0.36 s
- the write unlock: a write is refused with the unlock off, accepted with it on, and still
  refused for a request the operator did not ask for — checked against a server that counts
  TCP accepts, so "refused before a socket is opened" is measured, not asserted. The same
  test covers every snapshot, repository, SLM and index-management call the UI makes
- every page rendered against the real core in jsdom (`tools/render-check.mjs`), and the
  config reload path driven end to end with a sealed credential
- the full UI (all 7 pages) in a browser through the dev bridge, and the real Tauri app on
  Linux under Xvfb: config → tunnel → trust prompts → 3/3 clusters online
- the Windows (mingw) build of the core under Wine: same tunnel / pin / guard flow, plus
  VAULT_SET/GET/DEL against the Windows Credential Manager API. The WebView2 window cannot
  run under Wine, so the GUI on real Windows is the one step not exercised here.

## Recommendation

- Use `tls: system` for clusters whose CA you did install; `auto` for the self-signed ones.
- One `jump_hosts:` entry per jump host, not per cluster — the SSH session is shared.
- Keep the jump-host key restricted (`restrict,port-forwarding,permitopen`) exactly as for
  esfleet; the app needs nothing more.
- Leave `readOnly: true`. When you do need to write, tick *Allow writes* on the page you are
  working from rather than flipping the file: the unlock covers only the actions you take by
  hand, is forgotten when the app closes, and leaves every automatic refresh read-only.
  Reserve `readOnly: false` for a machine whose whole purpose is administration.

## Reference links and other docs

- esfleet `DEPLOY.md` — jump-host accounts, restricted keys, host-key fingerprints.
- ElasticVue Pro extension build notes / certificate-trust finding (project docs).
- Tauri 2: https://tauri.app — WebView2 on Windows Server 2016 needs the Evergreen runtime.
- russh (SSH client), rustls (TLS), reqwest (HTTP), keyring (Windows Credential Manager).
