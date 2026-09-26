# ElasticVue Pro — Zabbix modules

The Zabbix frontend side of ElasticVue Pro: the Clients page, the client master template it
writes, and the report widgets. The templates ElasticVue Pro itself feeds (client plan, alerts,
log delay) are in `../../deploy/zabbix/`.

| Folder | What | Import |
|---|---|---|
| `clients-module/` | **ElasticVue Pro → Clients** page: add, edit, remove clients (DI / On-Prem) and their hosts, CSV bulk import with confirmation, three backups with restore, configurable roles; writes the master template | copy into `modules/` as `evp_clients`, data folder (see its README), then `master/import.py` |
| `master/` | **ElasticVue Pro client master** — one host per client (made by the Clients page): requested / allocated / used per role and family, shortfall alerts, one dashboard per client. The template is written by the Clients page from its roles | `master/import.py` (set-up), then *Write master template* |
| `capacity-widget/` | **Client capacity** dashboard widget — every client in one table, coloured, with CSV / Excel export | copy into Zabbix's `modules/`, then `master/import.py` enables it and builds the dashboard |
| `resources-widget/` | **Client resources** dashboard widget — Requested / Allocated / Used per family or role, plus ES storage and log delay; expand a client into its servers; Type filter, Columns dialog, CSV / Excel export | copy into `modules/` as `evp_resources`, then `master/import.py` |
| `volume-widget/` | **Volume report** dashboard widget — the client plan per cluster, laid out as in ElasticVue Pro (sections over columns), with CSV / Excel export. Columns come from the ElasticVue Pro client plan template itself | copy into Zabbix's `modules/` as `evp_volume`, then `volume-widget/import.py` |
| `shared/` | the widgets' export, Columns dialog and styles, and the PHP they share with the Clients page (data folder, roles, column settings); `node sync-assets.mjs` copies them into each module | — |

Order on a fresh Zabbix: the SISA templates, then the ElasticVue Pro repository's templates
(`deploy/zabbix/setup/zbx_phase34.py`: client plan, alerts, log delay), then
`master/import.py`, then *Write master template* on the Clients page.

Tests (from this folder): `node --test clients-module/test/*.test.mjs shared/test/*.test.mjs capacity-widget/test/*.test.mjs volume-widget/test/*.test.mjs resources-widget/test/*.test.mjs`
