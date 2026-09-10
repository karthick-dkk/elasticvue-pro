# Hosted ElasticVue Pro — phase 1

The same Rust core and the same UI as the desktop app, on a Linux server, in three
containers, with **one exposed port (443)** and an authentication gate in front. The plan
and the decisions behind it are in [docs/HOSTED-DEPLOYMENT-PLAN.md](../docs/HOSTED-DEPLOYMENT-PLAN.md).

```
browser ──TLS──▶ nginx (auth gate) ──▶ core (espro-bridge) ──▶ your clusters / jump hosts
                                        └──▶ postgres
```

## Before you start — read this

The core trusts an `X-Auth-User` header that nginx sets **after** authenticating. That is
what makes the whole thing safe, and it only holds while the core is reachable through
nginx and nothing else. Two consequences:

- **Never publish port 8765.** The compose file does not. Do not add it.
- **Do not run the core with `ESPRO_BIND=0.0.0.0` outside this compose setup.** Without the
  proxy it is an open Elasticsearch console holding your credentials.

## Install (Linux, Docker Compose v2)

```bash
cd deploy

# 1. Settings
cp .env.example .env                       # LISTEN port, where the SSH keys are

# 2. TLS — a real certificate, or a self-signed one to start:
mkdir -p tls && openssl req -x509 -newkey rsa:4096 -nodes -days 825 \
  -keyout tls/privkey.pem -out tls/fullchain.pem -subj "/CN=elasticvue.internal"

# 3. Who may log in (phase-1 gate: HTTP basic). One line per person.
./make-htpasswd.sh alice
./make-htpasswd.sh bob

# 4. Database password
mkdir -p secrets && openssl rand -base64 32 > secrets/db_password

# 5. The cluster config — the same config_cluster.json the desktop app writes,
#    secrets sealed with the master password. Copy it in, and the SSH keys it names.
mkdir -p config ssh
cp /path/to/config_cluster.json config/
cp ~/.ssh/id_ed25519 ssh/                  # any keyFile the config refers to

# 6. Up
docker compose up -d --build
docker compose logs -f
```

Open `https://<server>/`, sign in, and pick `/app/config/config_cluster.json` when the app
asks for a config. Jump-host key paths in the config should be `/app/ssh/<file>`.

## Logs — everything, in one place

Every container logs to stdout, so `docker compose logs -f [core|nginx|db]` shows it all
and any collector that reads Docker logs (Filebeat, Promtail, Fluent Bit) picks it up.

| Stream | What | Shape |
|---|---|---|
| `nginx` access | every request: user, IP, method, URI, status, timing | one JSON object per line |
| `core` | the core's own log — connections, tunnels, trust decisions | JSON (`RUST_LOG` controls level) |
| `core` **audit** | **every write, by whom**: user, message type, cluster, method, path, whether it succeeded | JSON, `target: "audit"` |

The audit stream is the one that answers "who deleted that index":

```bash
docker compose logs core | grep '"target":"audit"' | jq .
```

Reads are not audited — they are the overwhelming majority of traffic and carry nothing
worth recording. Anything that changes a cluster, a pin, the write unlock or the config is.

## Rotating the gate later

nginx's `auth_basic` block is the only part that knows how people log in. Replacing it
with `oauth2-proxy` for SSO, or with a PAM module, changes nothing in the core: it only
needs `X-Auth-User` to arrive from something it can trust.

## What phase 1 does not do yet

- **Roles.** Every authenticated user has the same rights as the desktop operator. RBAC is
  phase 2 and uses the `users.role` column the schema already has.
- **A per-user write unlock.** *Allow writes* is a switch inside the core process, and in
  phase 1 there is one core process for everyone — so once any signed-in user turns it on,
  writes are permitted for every user until it is turned off or the container restarts.
  Every write is still audited under the name of whoever sent it, so the record is right;
  the *permission* is just shared. Phase 2 makes the unlock a per-user, per-role decision.
  Until then, treat "who may sign in" as "who may write".
- **Notes in Postgres.** The `acks` and `notes` tables exist; the UI still keeps them in the
  browser. Wiring the UI to the database is next, and until then two people do not see each
  other's notes.
- **Zabbix.** A polling endpoint for alerts and the volume report is planned; see the plan.

## Trying it on one machine first

`deploy/trial.sh` brings the stack up against a mock cluster and proves the four things
the deployment exists for: no credentials → 401 at nginx; valid credentials → the UI and
the bridge over TLS; a write appears in the core's audit log under the signed-in user's
name; and the core has no host port binding and is unreachable from a container outside
the compose network. Run it after any change to the compose file or nginx config.

Note that `docker compose ps` shows `8765/tcp` against the core. That is the image's
`EXPOSE` metadata — the port is open *inside* the compose network — not a host mapping;
a mapping would read `0.0.0.0:8765->8765/tcp`, as it does for nginx on 443.

## Updating

```bash
git pull && docker compose up -d --build
```

Trust decisions (`pins.json`) live in the `core-data` volume and survive rebuilds.
