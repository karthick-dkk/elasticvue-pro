#!/usr/bin/env bash
# Hosted-mode contract for espro-bridge, checked black-box against the real binary:
#
#   1. with ESPRO_BIND set to a non-loopback address, a request without X-Auth-User is
#      refused, one with it is served, and a blank header is not an identity;
#   2. every write is audited on stdout as JSON with the user's name, reads are not;
#   3. the default (loopback) mode needs no header at all.
#
# The audit stream is on STDOUT on purpose: that is what `docker compose logs` captures.
#
#   cargo build -p espro-core --features bridge --bin espro-bridge
#   tools/hosted-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=${BIN:-target/debug/espro-bridge}
[ -x "$BIN" ] || { echo "build first: cargo build -p espro-core --features bridge --bin espro-bridge"; exit 1; }

free_port() { python3 -c "import socket;s=socket.socket();s.bind(('',0));print(s.getsockname()[1]);s.close()"; }
post() { curl -s -X POST "$1" -H 'content-type: application/json' "${@:2}"; }
field() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1'))"; }
fail=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; fail=1; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

echo "== hosted mode =="
P=$(free_port); OUT=$(mktemp)
ESPRO_BIND=0.0.0.0 RUST_LOG=info "$BIN" ui "$P" >"$OUT" 2>&1 & PID=$!; disown
trap 'kill $PID 2>/dev/null; rm -f "$OUT"' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$P/"; do sleep 0.2; done
B="http://127.0.0.1:$P/bridge"

check "no header is refused"        "$(post $B -d '{"type":"PING"}' | field kind)" "unauthenticated"
check "blank header is refused"     "$(post $B -H 'x-auth-user:  ' -d '{"type":"PING"}' | field kind)" "unauthenticated"
check "a named user is served"      "$(post $B -H 'x-auth-user: alice' -d '{"type":"PING"}' | field ok)" "True"

post $B -H 'x-auth-user: alice' -d '{"type":"WRITE_UNLOCK","on":true}' >/dev/null
post $B -H 'x-auth-user: alice' -d '{"type":"ES","clusterId":"x","method":"DELETE","path":"/idx","allowWrites":true}' >/dev/null
post $B -H 'x-auth-user: alice' -d '{"type":"ES","clusterId":"x","method":"GET","path":"/"}' >/dev/null
sleep 0.3
AUDIT=$(grep -c '"target":"audit"' "$OUT" || true)
check "writes are audited (unlock + delete = 2 lines)" "$AUDIT" "2"
check "the audit line names the user"  "$(grep '"target":"audit"' "$OUT" | grep -c '"user":"alice"')" "2"
check "reads are not audited"          "$(grep '"target":"audit"' "$OUT" | grep -c '"method":"GET"' || true)" "0"
kill $PID; wait $PID 2>/dev/null || true

echo "== dev mode (loopback) =="
P2=$(free_port)
"$BIN" ui "$P2" >/dev/null 2>&1 & PID=$!; disown
until curl -s -o /dev/null "http://127.0.0.1:$P2/"; do sleep 0.2; done
check "no header needed on loopback" "$(post http://127.0.0.1:$P2/bridge -d '{"type":"PING"}' | field ok)" "True"

[ $fail -eq 0 ] && echo "ok: hosted-mode contract holds" || { echo "FAILED"; exit 1; }
