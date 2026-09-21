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

# PING is the handshake and has to answer before anyone signs in, so it is not the thing
# to probe for refusal — CONFIG_READ is. What PING owes us instead is silence about the
# estate: it once returned the cluster list, the config path and the request rates to a
# bare curl, which is how that went unnoticed.
check "no header is refused"        "$(post $B -d '{"type":"CONFIG_READ"}' | field kind)" "unauthenticated"
check "blank header is refused"     "$(post $B -H 'x-auth-user:  ' -d '{"type":"CONFIG_READ"}' | field kind)" "unauthenticated"
check "the handshake still answers" "$(post $B -d '{"type":"PING"}' | field ok)" "True"
check "the handshake names nothing" "$(post $B -d '{"type":"PING"}' | python3 -c '
import json,sys
d = json.load(sys.stdin)
named = [k for k in ("clusters","dataDir","configHint","defaultConfigPath",
                     "requests","tunnels","uptimeSec","defaultUser","defaultPasswordUnchanged") if k in d]
print(",".join(named) or "nothing")')" "nothing"
check "a named user is served"      "$(post $B -H 'x-auth-user: alice' -d '{"type":"PING"}' | field ok)" "True"

post $B -H 'x-auth-user: alice' -d '{"type":"WRITE_UNLOCK","on":true}' >/dev/null
post $B -H 'x-auth-user: alice' -d '{"type":"ES","clusterId":"x","method":"DELETE","path":"/idx","allowWrites":true}' >/dev/null
post $B -H 'x-auth-user: alice' -d '{"type":"ES","clusterId":"x","method":"GET","path":"/"}' >/dev/null
sleep 0.3
# Counted by "names a user" rather than by every audit line, because the stream also
# carries things this process did on its own — the scheduled measurement announcing that
# it started is the first of them, and it has no user because nobody asked for it.
AUDIT=$(grep '"target":"audit"' "$OUT" | grep -c '"user":' || true)
check "writes are audited (unlock + delete = 2 lines)" "$AUDIT" "2"
check "the audit line names the user"  "$(grep '"target":"audit"' "$OUT" | grep -c '"user":"alice"')" "2"
check "reads are not audited"          "$(grep '"target":"audit"' "$OUT" | grep -c '"method":"GET"' || true)" "0"

# The one timer in the product. It exists here and nowhere else, it says so on the way
# up, and it is disarmed until an admin arms it — a fresh server writes nothing.
check "the scheduler announces itself" "$(grep -c 'delay sink: timer started' "$OUT" || true)" "1"
# Reading the schedule is as admin-only as arming it: it names the cluster credentials
# would be sent to. Signing in properly is what the in-process tests do; what this
# script is for is proving the refusal reaches the wire.
check "reading it needs a caller"      "$(post $B -d '{"type":"DELAY_SINK_GET"}' | field kind)" "unauthenticated"
check "arming it needs a caller"       "$(post $B -d '{"type":"DELAY_SINK_SET","config":{"enabled":true,"sinkClusterId":"x"}}' | field kind)" "unauthenticated"
check "running it needs a caller"      "$(post $B -d '{"type":"DELAY_SINK_RUN"}' | field kind)" "unauthenticated"
kill $PID; wait $PID 2>/dev/null || true

echo "== dev mode (loopback) =="
P2=$(free_port)
"$BIN" ui "$P2" >/dev/null 2>&1 & PID=$!; disown
until curl -s -o /dev/null "http://127.0.0.1:$P2/"; do sleep 0.2; done
check "no header needed on loopback" "$(post http://127.0.0.1:$P2/bridge -d '{"type":"PING"}' | field ok)" "True"
# Loopback is the portable edition: an app that is only running while somebody has it
# open must not offer to do anything every two hours.
check "no scheduler off hosted"     "$(post http://127.0.0.1:$P2/bridge -d '{"type":"DELAY_SINK_GET"}' | field supported)" "False"

[ $fail -eq 0 ] && echo "ok: hosted-mode contract holds" || { echo "FAILED"; exit 1; }
