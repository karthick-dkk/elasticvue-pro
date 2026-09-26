# Clients page (Zabbix 7.0 module)

**ElasticVue Pro → Clients** (Super admins): every client, its type (DI / On-Prem), hosts and
last change — add, edit, remove, bulk import, backups, roles.

## Clients

| Action | What happens |
|---|---|
| **Add client** | Creates (or reuses) the host group named after the client, then `<client>-Master` (figures, alerts, dashboard), `<client>-ES-Cluster` when an ES URL is given, `<client>-ULM` when a bucket is given, and one Linux host per IP, named by its role: `karthi-ES-Data-Hot-1`, `karthi-Parser-2`, `karthi-AIML-1`. |
| **Type** | **DI**: log archive (S3 bucket, region, tag1 values) and ES URL required. **On-Prem**: all optional. |
| **Set up as client** | For a cluster made by hand before this page. Its hosts are **kept** — history, passwords — renamed to the pattern, and only what is missing is added. Machines without a role are listed; put an IP under a role to take it on. |
| **Edit** | Change anything. An IP added creates its host (or moves an existing one to that role); an IP removed deletes the host **only if this page made it**. Numbers are kept: removing -2 does not rename -3. |
| **Remove** | Deletes the hosts this page made, with their history. Hosts made by hand and host groups stay. |

Hosts the page makes carry `managed-by: elasticvue-clients`; nothing without it is ever deleted.
Machines join their role's host group and their family's (`ES Data Hot` and `ESNodes`).
Requested figures are per role (CPU cores, memory GB, disk GB, disk mount); each family's total
is the sum of its roles. 0 or empty = not set.

## Bulk import (CSV)

**Download CSV template** (empty, one column per field and per role), fill it, **Import CSV…**.
Or **Export clients (CSV)**, edit, import back. Every row is checked first; one error — a bad
field, a client twice, an IP under two clients — and nothing is applied.

- **New clients** are added straight away, after a backup.
- **Changes to existing clients** are listed field by field (old → new, hosts added / moved /
  deleted) and wait for a tick. A change that deletes a host is never ticked for you.
- **Overlaps** — an IP another client already has in Zabbix, an ES URL or tag1 value two clients
  share — are warnings; a new client with one waits for a tick too.
- A column left out means "no change"; an empty cell means "clear". Clients missing from the file
  are not removed. After applying, each client is read back from Zabbix and compared with the file.

## Backups

Taken before every change — save, removal, import, role change, restore — and the newest **three**
kept. **Restore** brings back roles, settings and machines; a client that is as it was is left
alone, clients added since are removed (their page-made hosts), and the present is backed up
first, so a restore can be undone. Each backup can be downloaded as CSV.

## Roles

Families (ES, Parser, Forwarder, Engine) and their roles (ES Data Hot / Warm, Coordination,
Master; Parser, S3 Parser; Forwarder; UEBA, AIML). Add a family or role (e.g. SOAR), rename,
reorder, remove (refused while machines use it). Each change rewrites the master template, so
the new role is in every client's form, the CSV, the figures and alerts, and the Client resources
report at once.

## Install

1. Copy this folder to Zabbix's modules directory as `modules/evp_clients` (Docker: mount it at
   `/usr/share/zabbix/modules/evp_clients`).
2. Give zabbix-web a writable data folder for roles, column settings and backups, and point
   `EVP_DATA_DIR` at it. With Docker, a named volume over `/var/lib/zabbix` (empty and owned by
   zabbix in the image, so the volume starts owned by zabbix):
   ```yaml
   environment:
     EVP_DATA_DIR: /var/lib/zabbix/elasticvue
   volumes:
     - evp-data:/var/lib/zabbix
   ```
   Without it the page shows a red banner and refuses every change (no backup, no change).
3. `../master/import.py` checks the templates, creates groups and enables the modules; then
   **Write master template** on the page.

The widget modules keep copies of `lib/Store.php`, `Roles.php`, `ColumnSettings.php` from
`../shared/php/` (`node ../sync-assets.mjs`). Tests: `php test/spec.test.php` (or
`node --test test/spec.test.mjs`, which uses a PHP container).
