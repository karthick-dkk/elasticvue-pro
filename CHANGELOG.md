# Changelog

## 2.2.0 — 2026-09-09

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

### Infrastructure
- Continuous integration: `ci.yml` (core tests, clippy, UI checks, dependency advisories) and
  `build-windows.yml` (portable zip on every push, NSIS installer and release assets on a tag).
  The README's build badge pointed at a repository that does not exist.
- Test suite grown from 6 unit tests to 61, including the bridge message API, the transport's
  error classification, the certificate trust flow — trust-on-first-use, pin mismatch and
  rotation recovery — against real sockets and a real TLS handshake, and every snapshot,
  repository, SLM and index-management call the UI makes.
- `tools/check-ui.mjs`: parses every UI module and resolves each named import. The UI has no
  bundler, so a mistyped import used to surface as a blank page.
- `tools/render-check.mjs`: renders every page against a running core in jsdom. A static
  check cannot see a call to something that was never imported at all; this does.
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
