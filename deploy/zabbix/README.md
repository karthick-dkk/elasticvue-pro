# Automation monitoring via Zabbix

The automation rules only ever ran while someone had the Automation page open. That makes
a notification close to useless — it arrives when you have already found the problem
yourself. This wires the same rules to a schedule, and lets Zabbix pull the answer.

Two things made a push webhook the wrong tool here:

- **The UI cannot make outbound requests.** The desktop WebView's content policy is
  `connect-src ipc: http://ipc.localhost`, so `fetch()` to a webhook is blocked by policy,
  not by a bug. In hosted mode CORS blocks it anyway, since Slack, Teams and most
  receivers send no `Access-Control-Allow-Origin`.
- **Nothing was evaluating the rules unattended.** Even with delivery solved, a webhook
  would only have fired while you were watching the screen.

Pulling fixes both, and reuses alerting you already run.

## What produces the data

`tools/espro-scrape.mjs` imports `ui/js/core/automation.js` directly rather than restating
any rules, so there is one definition of "safe to delete" and the scrape cannot drift from
what the page shows. It needs no browser: the core modules touch no DOM, so the only shim
is a base URL for the relative `/bridge` path the UI's transport posts to.

```bash
node tools/espro-scrape.mjs --config clusters.yaml            # JSON on stdout
node tools/espro-scrape.mjs --config clusters.yaml --out /var/lib/elasticvue-pro/automation.json
node tools/espro-scrape.mjs --config clusters.yaml --format sender | zabbix_sender -z zbx -i -
```

It reads. It never writes to Elasticsearch — a rule returns a description of work, and
running that work still needs a person in the app, behind its own confirmation and the
two-gate write guard. Exit status is 0 whenever a document was produced, even if clusters
were unreachable; an unreachable cluster is a fact to report, not a reason to report
nothing. Only failing to produce a document at all exits non-zero.

### Two things it will tell you rather than hide

- **`generatedEpoch`** — a scraper that has died looks exactly like a healthy fleet. The
  template's staleness trigger is the one to fix first if it fires; until it clears, every
  other item is reporting the last thing it saw.
- **`problems`** — a config holding sealed `enc:v1:` secrets cannot be unlocked by a
  headless run. It says so, instead of reporting every cluster as unreachable and looking
  like an outage.

## Running it on a schedule

### Hosted stack (Docker)

```bash
docker compose -f docker-compose.yml -f zabbix/compose.scraper.yml up -d
```

The scraper reaches the core over the internal network — the core stays unpublished — and
writes one JSON file to a volume nginx serves behind the auth gate you already have.

**One change this does not make for you.** Serving the file needs a location in
`deploy/nginx/nginx.conf`, and that file is your TLS front door, so add it yourself:

```nginx
    # Before `location / { proxy_pass ... }`. Exact match, so it wins over the proxy.
    # It inherits the auth_basic gate above, so Zabbix must authenticate like anyone else.
    location = /automation.json {
      alias /usr/share/nginx/state/automation.json;
      default_type application/json;
      add_header Cache-Control "no-store" always;
    }
```

Then `docker compose restart nginx`.

### Bare metal (systemd)

```bash
install -m644 espro-scrape.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now espro-scrape.timer
systemctl list-timers espro-scrape.timer
```

Adjust the paths in the unit — it assumes the repo at `/opt/elasticvue-pro`, the config at
`/etc/elasticvue-pro/clusters.yaml`, and an `espro` user that can read both.

### Push instead of pull

If you would rather not serve a file, `--format sender` emits `zabbix_sender` lines for
trapper items. Same data, same keys; you lose the low-level discovery unless you send the
two `espro.discovery.*` items too, which that format includes.

**Five minutes is a sensible floor either way.** Proving an index is safe to delete means
listing every snapshot in every repository, which is the expensive half of the work, and
indices are dated by day — polling harder buys nothing.

## Zabbix

Import `template-elasticvue-pro.yaml` (Data collection → Templates → Import), link it to a
host, and set four macros:

| Macro | Meaning |
| --- | --- |
| `{$ESPRO.URL}` | where the document is served, e.g. `https://elasticvue.internal/automation.json` |
| `{$ESPRO.USER}` | HTTP basic user — the hosted stack is behind an auth gate |
| `{$ESPRO.PASSWORD}` | that user's password (secret text) |
| `{$ESPRO.STALE}` | how long without a scrape before it alerts (default `30m`) |

The host needs no Zabbix agent. One HTTP request fetches the whole document and every
other item derives from it, so polling cost does not grow with clusters or rules. Two
discovery rules build per-cluster and per-rule items automatically from the
`{#CLUSTER.ID}` / `{#RULE.ID}` arrays the scrape emits.

### What the triggers mean

| Trigger | Severity | Why it matters |
| --- | --- | --- |
| the scrape has stopped running | High | Fix before trusting anything else on this template |
| a cluster could not be reached | Average | Its rules were not evaluated at all |
| a rule failed to evaluate | Average | Usually a malformed automation in `clusters.yaml` |
| automation held work back | Warning | A rule matched indices it then refused to propose — most often past retention with no proved snapshot. The case most worth a human looking at it |
| work waiting for review | Information | Proposals are waiting in the app. Nothing runs until a person runs it |

"Held back" alerting louder than "proposals waiting" is deliberate. A proposal is routine
housekeeping; a refusal means the rule found something it could not make safe.

## Authentication

Three separate boundaries. Only the first involves Zabbix credentials.

### 1. Zabbix to the scrape document

HTTP basic, through the auth gate the hosted stack already has. Add a user:

```bash
./make-htpasswd.sh zabbix          # bcrypt, prompts for the password
```

Then set `{$ESPRO.USER}` and `{$ESPRO.PASSWORD}` on the host. The template's master item
is `authtype: BASIC` and every other item derives from it, so this is the only credential
Zabbix needs.

The `location = /automation.json` block inherits `auth_basic` from the enclosing `server`,
which is the only reason the document is protected. Putting it outside that server, or
adding `auth_basic off;`, publishes your fleet's index names to anyone who can reach the
port.

If the stack uses a self-signed or internal-CA certificate, either add that CA to the
Zabbix server's trust store or clear "SSL verify peer" and "SSL verify host" on the master
item. Prefer the CA — clearing both turns off the only check that the host answering is
the one you meant.

### 2. The scraper to the core — use an API token

Mint one on the **Accounts** page (hosted builds only) with the **user** role: the scrape
reads indices and snapshots, so `guest` is not enough. The secret is shown once, is stored
only as a SHA-256 hash, and can be revoked from the same page.

Put it in `deploy/.env`, which is gitignored:

```
ESPRO_TOKEN=espro_…
```

The scraper reads `$ESPRO_TOKEN` and sends it as `Authorization: Bearer`. It takes
`--token` too, but prefer the environment — a secret on a command line is visible to
anyone who can run `ps`.

**Why a token rather than the user header.** When `ESPRO_BIND` is non-loopback the bridge
requires `X-Auth-User` to be present and non-empty, and checks it no further: the header
is trusted because nginx sets it, and the security comes from the core being unreachable
except through the proxy. Sent directly, `X-Auth-User: root` is accepted as readily as any
other name. So `--auth-user` **names** the scrape in the audit log; it does not
authenticate it. A token is different — the core issued it, bound a role to it, and can
revoke it — which is what makes the audit line worth reading.

The bridge prefers a token over the header when both are present, so adding one to an
existing deployment needs no other change.

`--auth-user` remains worth passing on a bridge with no token: the bridge decides whether
to demand the header from its own bind address, not the client's, so a bridge on `0.0.0.0`
rejects even a loopback request that has neither.

### 3. The scraper to Zabbix, if you push instead of pull

`--format sender` has no shared secret of its own. A trapper item accepts a value when the
host name and item key match, so restrict it:

- set **Allowed hosts** on the trapper items to the scraper's address, and
- encrypt with PSK — `zabbix_sender --tls-connect psk --tls-psk-identity <id>
  --tls-psk-file <file>` against a host configured for PSK.

Without both, anything that can reach port 10051 can write these values.

### What never gets a Zabbix credential

Elasticsearch. Zabbix reads one JSON file; it never talks to a cluster, and the cluster
credentials stay where they were — sealed in the config the core reads. Nothing in this
directory widens what the core can reach.

## What this does not do

Arming — letting a rule act unattended — is still off, and not because of anything here.
The hosted write unlock is a single switch shared by every signed-in user until RBAC
lands, so an armed rule would run under whoever unlocked writes last. See `canArm()` in
`ui/js/core/automation.js`.
