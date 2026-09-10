#!/usr/bin/env bash
# End-to-end trial of the hosted stack on this machine, against the mock cluster.
# Proves the four things the deployment is for:
#   1. no credentials -> 401 at nginx, the core is never reached
#   2. valid credentials -> the UI and the bridge work through TLS
#   3. a write shows up in the core's audit log under the signed-in user's name
#   4. port 8765 is NOT reachable from outside the compose network
set -uo pipefail
cd "$(dirname "$0")"
LISTEN=${LISTEN:-443}
U=alice; PW='test-password-1'
fail=0; ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; fail=1; }

docker compose up -d 2>&1 | tail -3
echo "waiting for nginx…"
for i in $(seq 1 40); do curl -sk -o /dev/null "https://127.0.0.1:$LISTEN/" 2>/dev/null && break; sleep 1; done
echo
echo "== 1. no credentials =="
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$LISTEN/")
[ "$code" = 401 ] && ok "GET / without credentials -> 401" || bad "GET / without credentials -> $code (want 401)"
code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"PING"}')
[ "$code" = 401 ] && ok "POST /bridge without credentials -> 401" || bad "POST /bridge without credentials -> $code"

echo "== 2. with credentials, through TLS =="
code=$(curl -sk -o /dev/null -w '%{http_code}' -u "$U:$PW" "https://127.0.0.1:$LISTEN/")
[ "$code" = 200 ] && ok "UI served over TLS" || bad "UI -> $code"
ping=$(curl -sk -u "$U:$PW" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"PING"}')
echo "$ping" | grep -q '"ok":true' && ok "bridge answers PING: $(echo "$ping" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("v"+d["version"],"dataDir",d["dataDir"])')" || bad "PING -> $ping"

echo "== 3. audit trail names the user =="
curl -sk -u "$U:$PW" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"WRITE_UNLOCK","on":true}' >/dev/null
curl -sk -u "$U:$PW" -X POST "https://127.0.0.1:$LISTEN/bridge" -H 'content-type: application/json' -d '{"type":"WRITE_UNLOCK","on":false}' >/dev/null
sleep 1
# --no-log-prefix: each line is then exactly the JSON the core wrote, nothing else.
auditlines=$(docker compose logs --no-log-prefix core 2>/dev/null | grep '"target":"audit"' || true)
audit=$(printf '%s\n' "$auditlines" | grep -c "\"user\":\"$U\"" || true)
[ "$audit" -ge 2 ] && ok "$audit audit line(s) under user '$U'" || bad "expected >=2 audit lines for '$U', got $audit"
printf '%s\n' "$auditlines" | tail -1 | python3 -c 'import json,sys
for line in sys.stdin:
    if line.strip(): print("     latest:", json.dumps(json.loads(line)["fields"]))' 2>/dev/null || true

echo "== 4. the core is not reachable except through nginx =="
# Ask Docker, not the network: a probe of host:8765 would also hit an unrelated process
# that happens to listen there (a dev bridge, say) and blame the container for it.
# `docker inspect` is the authority: a null host binding means the port is exposed
# inside the network only. (`docker compose port` prints ":0" for the same state, and
# `compose ps` shows the image's EXPOSE as "8765/tcp" — neither is a host mapping.)
binding=$(docker inspect deploy-core-1 --format '{{index .NetworkSettings.Ports "8765/tcp"}}' 2>/dev/null || echo '?')
[ "$binding" = "[]" ] || [ "$binding" = "<no value>" ] || [ -z "$binding" ] \
  && ok "core has no host port binding (docker inspect: 8765/tcp -> none)" \
  || bad "core has a host binding for 8765: $binding — it must not"
# And from a fresh container outside the compose network, the core's address is unreachable.
if docker run --rm --network none alpine:3 sh -c 'true' >/dev/null 2>&1; then
  if docker run --rm alpine:3 sh -c 'wget -q -T 2 -O /dev/null http://deploy-core-1:8765/ 2>/dev/null'; then
    bad "core reachable from a container outside the compose network"
  else ok "core unreachable from outside the compose network"; fi
fi
docker compose ps --format '  {{.Service}}  {{.Status}}  {{.Ports}}'

[ $fail -eq 0 ] && echo "ok: hosted stack trial passed" || { echo "FAILED"; exit 1; }
