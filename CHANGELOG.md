# Changelog

## Unreleased
- Per-day ingest is now the **mean of the three heaviest of the last seven complete days**,
  replacing the earlier "seven-day mean, falling back to the top three when it is 30% lower".
  Simpler, and it sizes against days that actually happen; the report names the days it used.
- The volume report's default export is one row per cluster with every parameter as a column
  — the shape a spreadsheet wants. The on-screen layout is still available as a second button.
- **Nodes & shards** carries the capacity figures too: per-day indices size, both retention
  policies, live storage and how long the free space lasts, what the stated policy requires
  and whether it is met, the 30/90-day requirements, and the windows of live and snapshot data
  held. Same code as the volume report, so the two pages cannot disagree.

## 2.2.1 — 2026-09-09

First tagged release of this work. 2.2.0 was built and committed but never tagged, and its
Linux build could not compile: the credential store pulled in libdbus through Secret Service,
which is not present on a bare machine. 2.2.1 is 2.2.0 with that fixed.


### Fixed
- **Reload config from disk did nothing useful.** A config whose secrets are sealed (the
  app's own default format since 2.1.0) comes back locked when re-read. Boot opened it;
  reload did not — so every cluster silently lost its credential and went to auth errors.
  Reading a config is now one path (`ui/load-config.js`) used by boot, *Reload from disk*,
  *Pick another file* and the focus watcher: it reopens sealed secrets with the cached
  master password, re-applies a remembered credential, and only then reconnects.
- A reload that removed or renamed a cluster kept rendering it from cached data.
- `_msearch` and `_bulk` were sent as `application/json` because the content type was picked
  by sniffing the body's first character, and those bodies open with a `{` header line.
  Elasticsearch refuses that. The endpoint now decides.

### Operator actions
Writes are still off by default. Ticking **Allow writes** unlocks the session in the core
(never on disk, gone on restart); it grants nothing on its own, because each request must
*also* be one the operator asked for by hand. Anything on a timer stays read-only.

- **REST console: every method.** GET, HEAD, POST, PUT, PATCH and DELETE are always listed —
  this is the page where a person types the request. Destructive requests are confirmed by
  name before they go out.
- **~60 ready-made requests**, grouped: health and diagnostics, indices, shards and replicas
  (replica counts, `total_shards_per_node`, `max_shards_per_node`, split/shrink, reroute),
  disk watermarks (including clearing a flood-stage read-only block), ILM (a full
  hot/warm/delete policy, index templates, retry, start/stop), snapshots and SLM, search,
  and cluster settings.
- **Indices can be managed**: open, close, delete, move a shard to another node
  (`_cluster/reroute`), change replicas / refresh interval / allocation, and run refresh,
  flush, clear-cache or force-merge. One index from its row, or any ticked selection.
  Deleting more than one asks for the count to be typed back.
- **Snapshots can be managed**: create (with index selection and the usual options), delete,
  restore (index selection, rename pattern, aliases, global state), and *Free indices* —
  deleting the live indices a snapshot already holds, which is the usual way to reclaim the
  disk. Repositories can be added (fs, s3, azure, gcs, url), verified, cleaned up and removed.

### Pages
- **Snapshots & SLM** lists the latest 5 snapshots per repository by default, with *Show more*
  and *Show all*; a snapshot's name opens its indices, shards and failures.
- **Alerts is its own page**, with level, cluster and text filters, a row per alert linking to
  the page that answers it, and CSV export. The count sits on the nav tab. The Clusters page
  keeps a three-line summary instead of the full list.
- **Clusters can be searched and sorted** — by name, URL, tag, jump host, version or
  repository; sorted by name, health, disk used or free, nodes, shards, unassigned, version,
  last snapshot or open alerts, ascending or descending, and narrowed to what needs attention.

### Builds
- **macOS and Linux packages.** Releases now carry a package per platform, each built by CI
  on that platform: the Windows portable zip and NSIS installer as before, plus `.dmg` for
  Apple Silicon and Intel, and `.AppImage`, `.deb` and `.rpm` for Linux x64. The core, the
  read-only guard, the pinning and the UI are identical everywhere; the web view differs
  (WebView2 / WKWebView / WebKitGTK), and portable mode remains Windows-only. None of the
  binaries are code-signed, so macOS Gatekeeper needs right-click → *Open* on first run.
- The OS credential store now has a backend on every platform. `keyring` was built with only
  the Windows and macOS backends, so on Linux the optional "remember on this machine" compiled
  but had nothing to talk to. Linux uses the kernel keyring (`linux-keyutils`), which needs no
  system library — Secret Service would persist across a reboot but links libdbus, making
  `libdbus-1-dev` a build requirement for anyone compiling on Linux. The consequence is that
  on Linux a remembered credential lasts the login session; the encrypted config file remains
  the way to keep a secret across restarts.
- **The exe carries its version**: `elasticvue-pro-2.2.0.exe`, so which build a machine is
  running is answerable by looking at it rather than by starting it. The build it replaces
  moves to [`previous-releases/`](previous-releases/) with its checksum and a note on rolling
  back, instead of being overwritten.
- The copy committed at the repo root was rebuilt from this source. It had been the 2.1.0
  binary from the initial commit, so "run the exe from the repo" gave you none of the above.
- `tools/build-windows-cross.sh` runs on macOS as well as Ubuntu — it picks the `-posix` mingw
  drivers on Debian and the plain ones from Homebrew, and falls back to `shasum` where
  `sha256sum` is absent. `--install` refreshes the root build and archives the old one.
  The packaged `README.txt` now takes its version and exe name from the build rather than
  being edited by hand, which is how it had drifted to 2.1.0.

### Continuous integration
- `ci.yml` — core tests, clippy, UI checks and dependency advisories; `build-windows.yml` —
  the portable zip on every push, plus the NSIS installer and release assets on a `v*` tag.
  The README's build badge had pointed at a repository that does not exist.
- Test suite grown from 6 unit tests to **61**: the bridge message API, the transport's error
  classification, the certificate trust flow (trust-on-first-use, pin mismatch, rotation
  recovery) against real sockets and a real TLS handshake, and every snapshot, repository,
  SLM and index-management call the UI makes. The read-only guard's "refused before a socket
  is opened" is measured against a server that counts TCP accepts, not asserted.
- `tools/check-ui.mjs` parses all 31 UI modules and resolves every named import — the UI has
  no bundler, so a mistyped import used to surface as a blank page.
- `tools/render-check.mjs` renders all 8 pages against a running core in jsdom, and
  `tools/mock-es.mjs` gives them a cluster with data to draw. A static check cannot see a call
  to something that was never imported at all; this can, and it caught exactly that during
  development.
- One dependency advisory is **accepted rather than fixed**: RUSTSEC-2023-0071, the "Marvin
  Attack" timing sidechannel in `rsa`, which has no patched release upstream. It arrives via
  russh's `rsa` feature — what authenticates to a jump host with an `id_rsa` key. The
  reasoning is in [`.cargo/audit.toml`](.cargo/audit.toml) and disclosed in
  [SECURITY.md](SECURITY.md); `cargo audit` runs directly in CI so that file is the single
  source of truth and a local run agrees with CI exactly.
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
