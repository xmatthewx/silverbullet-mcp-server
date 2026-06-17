#!/usr/bin/env bash
# v0.6 smoke — tests move_page and the append/prepend no-create fix,
# plus the v0.3 scenarios carried forward.
#
# Usage:
#   1. In one shell: npm run dev
#   2. In another:   bash scripts/smoke-v0.6.sh
#
# Requires .env in repo root with MCP_TOKEN set, plus a real SB instance
# reachable from this machine.

set -euo pipefail

# shellcheck disable=SC1091
set -a; source .env; set +a

BASE="${MCP_BASE_URL:-http://localhost:8080}"
AUTH="Authorization: Bearer ${MCP_TOKEN}"
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"

# --- session bootstrap ---
INIT_HEADERS=$(mktemp)
INIT_BODY=$(curl -sS -D "$INIT_HEADERS" -X POST "${BASE}/mcp" \
  -H "$AUTH" -H "$CT" -H "$ACCEPT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
SESSION=$(grep -i '^mcp-session-id:' "$INIT_HEADERS" | awk '{print $2}' | tr -d '\r\n')
rm -f "$INIT_HEADERS"

if [ -z "$SESSION" ]; then
  echo "ERROR: no session id from initialize"
  echo "$INIT_BODY"
  exit 1
fi

echo "session: $SESSION"
echo "init body: $INIT_BODY"

curl -sS -X POST "${BASE}/mcp" \
  -H "$AUTH" -H "$CT" -H "$ACCEPT" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  > /dev/null

# --- helpers ---

extract() {
  awk '/^data: /{sub(/^data: /,""); print; exit}' \
    <<<"$1"
}

call() {
  local method="$1"
  local params="$2"
  local raw
  raw=$(curl -sS -X POST "${BASE}/mcp" \
    -H "$AUTH" -H "$CT" -H "$ACCEPT" -H "Mcp-Session-Id: $SESSION" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}")
  local extracted
  extracted=$(extract "$raw")
  if [ -n "$extracted" ]; then echo "$extracted"; else echo "$raw"; fi
}

tool() {
  local name="$1"
  local args="$2"
  call tools/call "{\"name\":\"${name}\",\"arguments\":${args}}"
}

hr() { printf '\n=== %s ===\n' "$*"; }

get_lm_from_single_block() {
  python3 -c '
import json, sys
r = json.load(sys.stdin)
print(json.loads(r["result"]["content"][0]["text"])["lastModified"])
'
}

get_lm_from_envelope() {
  python3 -c '
import json, sys
r = json.load(sys.stdin)
print(json.loads(r["result"]["content"][0]["text"])["lastModified"])
'
}

# Check that a tool response does NOT contain an ms-precision lastModified.
# Expects the full JSON-RPC response on stdin.
assert_no_ms_timestamp() {
  local label="$1"
  python3 -c '
import json, sys
r = json.load(sys.stdin)
text = json.dumps(r)
# Look for any lastModified value that is not rounded to seconds
import re
for m in re.finditer(r"lastModified[\":\s]+(\d+)", text):
    val = int(m.group(1))
    if val % 1000 != 0:
        print(f"FAIL: {sys.argv[1]} — found ms-precision lastModified: {val}")
        sys.exit(1)
print(f"OK: {sys.argv[1]} — no ms-precision lastModified leaked")
' "$label"
}

TS=$(date +%s)
PAGE="_smoke/v06-base-${TS}"
MOVE_SRC="_smoke/v06-move-src-${TS}"
MOVE_DST="_smoke/v06-move-dst-${TS}"
MOVE_BLOCKER="_smoke/v06-blocker-${TS}"

# ============================================================
# PART A — carried-forward v0.3 scenarios
# ============================================================

hr "A1. create_page"
CREATE=$(tool create_page "{\"page\":\"${PAGE}\",\"body\":\"# smoke\\n\\noriginal body\\n\"}")
echo "$CREATE"
LM1=$(echo "$CREATE" | get_lm_from_single_block)
echo "lastModified after create: $LM1"

hr "A2. read_page (envelope)"
READ=$(tool read_page "{\"page\":\"${PAGE}\"}")
echo "$READ"
LM2=$(echo "$READ" | get_lm_from_envelope)
test "$LM1" = "$LM2" && echo "OK: create lm == read lm" || echo "MISMATCH"

hr "A3. write_page with matching expected_last_modified"
WROTE=$(tool write_page "{\"page\":\"${PAGE}\",\"body\":\"# smoke\\n\\nupdated body\\n\",\"expected_last_modified\":${LM2}}")
echo "$WROTE"

hr "A4. write_page with stale lm (conflict expected)"
tool write_page "{\"page\":\"${PAGE}\",\"body\":\"stale\",\"expected_last_modified\":${LM2}}"

hr "A5. write_page on missing page (not_found expected)"
tool write_page "{\"page\":\"_smoke/no-such-${TS}\",\"body\":\"x\",\"expected_last_modified\":0}"

hr "A6. create_page on existing (already_exists expected)"
tool create_page "{\"page\":\"${PAGE}\",\"body\":\"x\"}"

hr "A7. create_page into _trash/ (forbidden_path expected)"
tool create_page "{\"page\":\"_trash/should-fail\",\"body\":\"x\"}"

hr "A8. invalid path (invalid_path expected)"
tool read_page "{\"page\":\"../escape\"}"

hr "A9. append_to_page"
tool append_to_page "{\"page\":\"${PAGE}\",\"content\":\"appended line\"}"

hr "A10. prepend_to_page"
tool prepend_to_page "{\"page\":\"${PAGE}\",\"content\":\"prepended line\"}"

# ============================================================
# PART B — append/prepend on missing page (v0.6 fix)
# ============================================================

hr "B1. append_to_page on missing page (not_found expected)"
tool append_to_page "{\"page\":\"_smoke/no-such-append-${TS}\",\"content\":\"should fail\"}"

hr "B2. prepend_to_page on missing page (not_found expected)"
tool prepend_to_page "{\"page\":\"_smoke/no-such-prepend-${TS}\",\"content\":\"should fail\"}"

# ============================================================
# PART C — move_page
# ============================================================

hr "C1. create source page for move"
tool create_page "{\"page\":\"${MOVE_SRC}\",\"body\":\"# Move test\\nThis page will be moved.\"}"

hr "C2. happy-path move"
MOVE_RESULT=$(tool move_page "{\"from\":\"${MOVE_SRC}\",\"to\":\"${MOVE_DST}\"}")
echo "$MOVE_RESULT"
echo "$MOVE_RESULT" | assert_no_ms_timestamp "move_page success"

hr "C3. verify dest exists"
tool read_page "{\"page\":\"${MOVE_DST}\"}"

hr "C4. verify source is gone (not_found expected)"
tool read_page "{\"page\":\"${MOVE_SRC}\"}"

hr "C5. from == to (invalid_path expected)"
tool move_page "{\"from\":\"${MOVE_DST}\",\"to\":\"${MOVE_DST}\"}"

hr "C6. dest already exists (already_exists expected)"
tool create_page "{\"page\":\"${MOVE_BLOCKER}\",\"body\":\"I block.\"}"
BLOCKED=$(tool move_page "{\"from\":\"${MOVE_DST}\",\"to\":\"${MOVE_BLOCKER}\"}")
echo "$BLOCKED"
echo "$BLOCKED" | assert_no_ms_timestamp "move_page already_exists"

hr "C7. source missing (not_found expected)"
MISSING=$(tool move_page "{\"from\":\"_smoke/does-not-exist-${TS}\",\"to\":\"_smoke/whatever-${TS}\"}")
echo "$MISSING"
echo "$MISSING" | assert_no_ms_timestamp "move_page not_found"

hr "C8. dest in _trash/ (forbidden_path expected)"
TRASH=$(tool move_page "{\"from\":\"${MOVE_DST}\",\"to\":\"_trash/nope\"}")
echo "$TRASH"
echo "$TRASH" | assert_no_ms_timestamp "move_page forbidden_path"

hr "C9. path validation on move"
tool move_page "{\"from\":\"../escape\",\"to\":\"somewhere\"}"
tool move_page "{\"from\":\"somewhere\",\"to\":\"../escape\"}"

# ============================================================
# Cleanup
# ============================================================

hr "Cleanup"
tool delete_page "{\"page\":\"${PAGE}\"}"
tool delete_page "{\"page\":\"${MOVE_DST}\"}"
tool delete_page "{\"page\":\"${MOVE_BLOCKER}\"}"

echo
echo "done. session: $SESSION"
echo
echo "Expected errors by section:"
echo "  A4: conflict       A5: not_found      A6: already_exists"
echo "  A7: forbidden_path A8: invalid_path"
echo "  B1: not_found      B2: not_found"
echo "  C4: not_found      C5: invalid_path   C6: already_exists"
echo "  C7: not_found      C8: forbidden_path C9: invalid_path (x2)"
echo
echo "Timestamp sweep: all assert_no_ms_timestamp checks should say OK."
echo "No response should have isError: true."
