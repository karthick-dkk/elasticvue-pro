# Changelog

## Unreleased
- Fixed: the **CLUSTER band in the volume report would not scroll**. The frozen column is
  the first column, but that band spanned the first three, and pinning the whole band cell
  froze all three — so it sat still while the columns beneath it moved. Every row of the
  sheet now freezes exactly one column's width.
- The volume report no longer carries "How that was measured" and "Days measured" as
  columns. The first was a sentence repeated down every row, which drowned the numbers on
  either side of it; the second is contained in that sentence. The explanation now hangs off
  the figure it explains, as hover text on the per-day value, so it can still be checked
  without taking up the grid.
- **Volume report columns are named in English.** "Per day", "Basis", "Lasts", "Holds",
  "Config = ILM" and the rest are gone; no label now needs its group header beside it to be
  understood, and no two columns share a name — "Policy" and "Storage sufficient" each
  appeared twice, in different groups, meaning different things.
- **Snapshots say which days of logs they hold**, not just when they ran. A snapshot taken
  this morning can contain ninety days of daily indices, and that span is what decides
  whether a given day can be restored. It is read from the dates in the index names, shown
  per snapshot as *Data inside covers*, and summarised for the repository as *Log data
  recoverable from*. Where a repository can only be read with `_cat`, which does not name
  the indices, the range reads "unknown" rather than blank.
- **An indices column on each snapshot**: the count is a button, and it opens the list of
  indices that snapshot holds with a search box and CSV export.
- **Number-key page shortcuts are gone**, along with the small digit each tab carried. A
  stray keypress moving the page out from under someone was worse than the shortcut was
  worth. The Alerts tab keeps its open-alert count — that is a reason to go there, not a
  shortcut.
- Fixed: **typing in a search box lost the caret after every keystroke.** Filtering rebuilds
  the region the box sits in, which destroyed and replaced the box mid-keystroke, so focus
  fell to the body and the next character went nowhere — most obvious on backspace.
  `mount()` now restores focus, the caret and any selection when the element it replaces is
  the one that had them, which fixes every search box at once rather than one page at a time.
- **Notes on an alert open in a panel anchored to the button**, instead of a row spliced
  into the table that pushed everything below it down the page. Hovering the note count
  peeks at them read-only; clicking opens the panel to add or remove. It closes on Escape or
  a click anywhere else, and adding a note raises a short confirmation rather than an alert
  box.
- **Hosted deployment (phase 1).** `espro-bridge` gains a hosted mode: with `ESPRO_BIND` set
  to a non-loopback address, every request must carry `X-Auth-User`, the identity a trusted
  reverse proxy sets after authenticating; without it the request is refused. Every write
  is audited as a JSON line on stdout — user, message type, cluster, method, path, outcome —
  and reads are not. `deploy/` holds a compose stack: nginx (TLS, HTTP-basic auth gate,
  sole published port), the core on an internal network as an unprivileged user, and
  Postgres with the schema for users, acknowledgements, notes and audit ready for phase 2.
  `tools/hosted-check.sh` proves the contract against the real binary and runs in CI. The
  plan, phases and open decisions are in `docs/HOSTED-DEPLOYMENT-PLAN.md`.
- **Deleting an index checks the snapshots first.** Every repository is listed and only a
  snapshot in state SUCCESS with no failure on that index counts as a copy — PARTIAL and
  IN_PROGRESS do not. The confirmation shows the verdict per index with the newest good
  copy; indices with none are unticked by default and must be ticked on purpose. A
  repository that cannot be read is reported as unknown rather than as "not in any
  snapshot".
- **Search live and snapshots together.** Tick *also search snapshots* on the Indices page
  and a name is looked for both on the cluster and inside every snapshot, with how many
  good copies each has.
- **Our own request count per cluster.** The core counts every request it sends, per
  cluster, over a five-minute window; the Clusters page shows it per cluster with the rate,
  and the status strip shows the fleet total. A request the read-only guard refused never
  reached a socket and is not counted.
- The read-only / writes-enabled pill left the title bar. Every page that can write carries
  its own *Allow writes* toggle, which says the same thing where it matters.
- **Disk balance on the Nodes page**, for clusters with more than one data node: per-node
  usage against the cluster's own watermarks, the spread between the fullest and emptiest
  node, shard counts against the average, and a plain verdict on whether **shard
  reallocation would help**. A skewed cluster and a full one need opposite responses, so a
  cluster whose every node is above the high watermark is told `would NOT help — add
  capacity` rather than being pointed at a rebalance that cannot work.
- Watermarks are read from `_cluster/settings` rather than assumed; when the cluster does
  not report them the page says the thresholds are assumed.
- **Suggested requests** alongside the verdict — allocation explain, retry failed
  allocations, check that rebalancing is enabled, move a named shard between the two nodes
  identified, clear a flood-stage read-only block, list the oldest indices. Each appears
  only when it applies, opens in the REST console prefilled instead of running from the
  page, and anything that changes the cluster is labelled.
- The verdict becomes an alert, so it reaches the Alerts page and the nav badge.
- **Volume analysis on the Indices page.** Daily volume broken down by an ECS field —
  `tag1`, `src_hostname`, or anything named in the new `volumeFields` setting — with a daily
  chart, a sortable table of values, click-to-isolate, and CSV export. A value is flagged
  when its latest complete day exceeds the mean of the previous seven by more than 40%;
  today is excluded from both sides, and a zero baseline is never a spike. Spikes also
  become alerts, so they reach the Alerts page and the nav badge.
  Size figures are estimates and say so: Elasticsearch reports store size per index, never
  per field value, so a value's share of the day's documents is applied to that day's index
  size. The document counts are exact.
- Fixed: days were derived from local date parts in one place and UTC in another, so for
  anyone not on UTC the partial current day was treated as complete and every value looked
  as though it had collapsed. Both the volume report and the new analysis now use UTC
  throughout, matching how `date_histogram` buckets and how index names are dated.
- **Navigation moved to the top.** The nine pages are a row of tabs under the title bar
  instead of a 216px column down the left, so a wide table gets the whole window. The brand
  and the status that lived in the sidebar foot — config file, cluster count, health, build,
  jump-host tunnels — are now a strip under the tabs.
- **The volume report reads as a spreadsheet**: one row per cluster, every parameter a
  column grouped by what it is about, the cluster column and header pinned while the rest
  scrolls, any column sortable, YES/NO coloured. The CSV export shares the same column
  definitions, so the file and the screen cannot diverge. The per-parameter summary is still
  available, and the per-cluster detail cards fold away.
- **Applied ILM and SLM policies.** The report now shows what the cluster actually enforces
  next to what the config says it should: the ILM policy the log indices are really attached
  to and the age its delete phase removes them at, and the SLM policy's `expire_after`,
  schedule and counts. Where config and cluster disagree the report says so — that is how
  retention drift gets noticed. When the config states no retention, the applied policy is
  used for sizing rather than leaving the figure blank.

## 2.2.2 — 2026-09-10

### Safer destructive actions
- Delete no longer sits in the row next to Open and Close. Every action that changes or
  removes something — indices, snapshots, repositories, certificate pins — is behind a **⋮
  menu** with a bin icon and a divider above it. The row keeps only what is reversible.
- Confirmations name the action in the button — *Yes, delete* / *No, cancel* — list what
  will be affected, and demand the count or the repository name typed back for the worst
  cases. Moving a shard confirms too, since it copies data across nodes. No browser
  `confirm()` remains in the UI.

### Volume report (new page)
- Per-day ingest, what retention costs, and whether each cluster's storage matches the
  policy it promises. The daily figure is the **mean of the three heaviest of the last seven
  complete days** — a plain seven-day mean under-provisions whenever the window catches a
  quiet weekend — and the report names the three days it used. Today is excluded throughout;
  its index is still being written to.
- Derived per cluster: the daily figure and a +30% planning buffer, live storage and how
  long the free space lasts, what the stated retention costs and whether the disk can hold
  it, the 30/90/365-day requirements, and the windows of live and snapshot data held.
- Clusters gain `liveRetention` and `snapshotRetention` — `30d`, `90 days`, `3M`, `6 months`,
  `1y` — editable and validated in the UI, falling back to the SLM policy's `expire_after`.
- Repository size is not a number Elasticsearch reports cheaply, so it sits behind a
  **Measure** button and reads "not measured" until asked. Anything unknowable shows a dash
  or "unknown" rather than a confident zero, and the 365-day backup figure is labelled an
  upper bound since snapshots are incremental.
- Export is CSV, one row per cluster with every parameter as a column; the on-screen layout
  is available as a second button.

### Alerts
- Alerts can be **acknowledged** and **annotated**. Each carries a key naming the problem
  rather than its current value — `<cluster>:disk`, not "disk 87.3%" — so a note written at
  86% is still attached at 91%, and only disappears when the condition clears. ACK records
  who and when; notes are timestamped, attributed, and survive a re-open. Kept in IndexedDB
  on that machine: a local operator log, not shared state.
- Search also looks inside notes, and CSV export carries the ack state, the acknowledger and
  the notes.
- A **graph view**: one bar per cluster, so a fleet is read at a glance instead of scrolled,
  and one per kind of problem, which says whether it is the same fault everywhere or
  different ones. Bars are coloured by the worst level present, clicking one filters the page
  to that cluster, and both cuts respect the filters above. Table, Graph and Graph + table
  are selectable.

### Reading long pages
- Alerts, Indices, Snapshots and Nodes use a compact density, and their tall secondary panels
  — charts, coverage strips, repositories, SLM — fold away and remember the choice. Folded
  panels build nothing, so Snapshots dropped from 630 DOM nodes to 508.
- Two panels open themselves when they have something to say: SLM when a policy's last run
  failed, snapshot availability when there is a gap in the window.
- The index filter is repeated directly above the list, with the row count and a
  clear-filters button; both boxes drive the same filter and stay in step.

### Naming and sorting
- **"Client" now means one thing.** A client is a cluster — one client, one Elasticsearch
  URL. The tenant parsed out of index names (`logstash-<source>-YYYY.MM.DD`) is a **source**,
  and the Indices and Live logs pages say so: Source picker, "All sources", "Sources detected",
  "Store size by source". The named group in `indexNameRegex` is `<source>`; `<client>` is
  still honoured, so existing configs keep working untouched. The `client` field in the
  Indices CSV export is now `source`.
- **Clusters** sorts by cluster size — the store size of its indices, shown as its own
  column — alongside the existing keys, and starts sorted by cluster name ascending.
  Cluster size is in the CSV export too.
- **Alerts** has a graph view: one bar per cluster, so a fleet is read at a glance instead
  of scrolled, and one per kind of problem, which says whether it is the same fault
  everywhere or different ones. Bars are coloured by the worst level present, clicking one
  filters the page to that cluster, and both cuts respect the filters above. Table, Graph
  and Graph + table are selectable.
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
