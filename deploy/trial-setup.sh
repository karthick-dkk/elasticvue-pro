#!/usr/bin/env bash
# Throwaway credentials so `trial.sh` runs on a fresh clone — and in CI, where none of
# the real ones exist because every one of them is gitignored.
#
# Everything here is deliberately worthless: a self-signed certificate, one user whose
# password is printed in this file, a random database password. Nothing is overwritten —
# if a file is already there it is left exactly as it is, so running this on a machine
# that holds real credentials cannot destroy them.
set -euo pipefail
cd "$(dirname "$0")"

TRIAL_USER=${TRIAL_USER:-alice}
TRIAL_PASS=${TRIAL_PASS:-test-password-1}
made=0

[ -f .env ] || { cp .env.example .env; echo "  made .env"; made=1; }

if [ ! -s tls/fullchain.pem ] || [ ! -s tls/privkey.pem ]; then
  mkdir -p tls
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout tls/privkey.pem -out tls/fullchain.pem -subj "/CN=elasticvue.trial" 2>/dev/null
  echo "  made tls/ (self-signed, 30 days — NOT for a real deployment)"; made=1
fi

if [ ! -s nginx/htpasswd ]; then
  mkdir -p nginx
  # The same bcrypt hash make-htpasswd.sh writes, from the same image — htpasswd is not
  # installed everywhere, and Python's crypt module was removed in 3.13. Docker is already
  # a requirement for the trial, so depending on it here adds nothing.
  docker run --rm httpd:2.4-alpine htpasswd -Bbn "$TRIAL_USER" "$TRIAL_PASS" > nginx/htpasswd
  # Not the login. nginx.conf has no auth_basic — signing in is the app's own job, and it
  # asks for an administrator on first run. This file only matters if you turn edge
  # authentication back on, and saying otherwise would send someone hunting for a
  # password prompt that is not there.
  echo "  made nginx/htpasswd (unused unless you re-enable auth_basic — not the app login)"; made=1
fi

# The config the compose file points ELASTICVUE_CONFIG at. It has to exist before the
# first start, and it cannot be created from the UI: ./config is mounted read-only, which
# is deliberate — the file holds cluster credentials and the core has no business writing
# it. So the starter is made here, empty, and the operator adds clusters by editing it on
# the host. Without this every fresh hosted deploy opens on "cannot read
# /app/config/config_cluster.json", which looks like a broken install and is not one.
if [ ! -s config/config_cluster.json ]; then
  mkdir -p config
  cat > config/config_cluster.json <<'JSON'
{
  "version": 2,
  "defaults": {
    "readOnly": true,
    "autoRefresh": false,
    "refreshIntervalSec": 30,
    "logIndexPattern": "logstash-*",
    "tls": "auto"
  },
  "jump_hosts": {},
  "clusters": []
}
JSON
  echo "  made config/config_cluster.json (no clusters yet — add them here, then restart the core)"; made=1
fi

if [ ! -s secrets/db_password ]; then
  mkdir -p secrets
  openssl rand -base64 32 > secrets/db_password
  echo "  made secrets/db_password"; made=1
fi

[ $made -eq 1 ] || echo "  nothing to do — every file the trial needs is already here"
