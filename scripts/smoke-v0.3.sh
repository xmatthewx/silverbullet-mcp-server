#!/usr/bin/env bash
# v0.3 smoke — runs through the scenarios from the plan against a
# locally-running MCP (npm run dev) using the dev-bypass MCP_TOKEN.
#
# Usage:
#   1. In one shell: npm run dev
#   2. In another:   bash scripts/smoke-v0.3.sh
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
# initialize returns the session id in the Mcp-Session-Id response header
# and the body is SSE-framed.
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

# Per MCP Streamable HTTP, the client must POST a notifications/initialized
# after capturing the session id before issuing any other request.
curl -sS -X POST "${BASE}/mcp" \
  -H "$AUTH" -H "$CT" -H "$ACCEPT" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  > /dev/null

# --- helpers ---

# Extract the first `data:` line out of an SSE response body and emit just
# the JSON-RPC payload. If the body isn't SSE (rare), pass it through.
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

# Pull lastModified from a tool response that returns a single JSON content
# block: result.content[0].text holds a JSON string with .lastModified.
get_lm_from_single_block() {
  python3 -c '
import json, sys
r = json.load(sys.stdin)
print(json.loads(r["result"]["content"][0]["text"])["lastModified"])
'
}

# Pull lastModified from read_page (envelope is in content[0]).
get_lm_from_envelope() {
  python3 -c '
import json, sys
r = json.load(sys.stdin)
print(json.loads(r["result"]["content"][0]["text"])["lastModified"])
'
}

PAGE="silverbullet/_smoke-$(date +%s)"

hr "2. create_page (expects lastModified in response)"
CREATE=$(tool create_page "{\"page\":\"${PAGE}\",\"body\":\"# smoke\\n\\noriginal body\\n\"}")
echo "$CREATE"
LM1=$(echo "$CREATE" | get_lm_from_single_block)
echo "lastModified after create: $LM1"

hr "3. read_page (envelope: metadata in content[0], body in content[1])"
READ=$(tool read_page "{\"page\":\"${PAGE}\"}")
echo "$READ"
LM2=$(echo "$READ" | get_lm_from_envelope)
echo "lastModified from read: $LM2"
test "$LM1" = "$LM2" && echo "OK: create lastModified == read lastModified" || echo "MISMATCH"

hr "4. write_page with matching expected_last_modified"
WROTE=$(tool write_page "{\"page\":\"${PAGE}\",\"body\":\"# smoke\\n\\nupdated body\\n\",\"expected_last_modified\":${LM2}}")
echo "$WROTE"
LM3=$(echo "$WROTE" | get_lm_from_single_block)
echo "lastModified after write: $LM3"

hr "5. write_page with stale expected_last_modified (conflict expected)"
tool write_page "{\"page\":\"${PAGE}\",\"body\":\"won't land\",\"expected_last_modified\":${LM2}}"

hr "6. write_page against a non-existent page (not_found expected)"
tool write_page "{\"page\":\"silverbullet/_smoke-no-such-page-$(date +%s)\",\"body\":\"x\",\"expected_last_modified\":0}"

hr "7. create_page on existing path (already_exists expected)"
tool create_page "{\"page\":\"${PAGE}\",\"body\":\"x\"}"

hr "8. create_page into _trash/ (forbidden_path expected)"
tool create_page "{\"page\":\"_trash/should-fail\",\"body\":\"x\"}"

hr "9. read_page on non-existent page (not_found expected)"
tool read_page "{\"page\":\"silverbullet/_smoke-definitely-not-there-$(date +%s)\"}"

hr "10. invalid path (invalid_path expected)"
tool read_page "{\"page\":\"../escape\"}"

hr "11. append_to_page (no lastModified in response)"
tool append_to_page "{\"page\":\"${PAGE}\",\"content\":\"appended line\"}"

hr "12. prepend_to_page (no lastModified in response)"
tool prepend_to_page "{\"page\":\"${PAGE}\",\"content\":\"prepended line\"}"

hr "13. cleanup: delete_page"
tool delete_page "{\"page\":\"${PAGE}\"}"

echo
echo "done. session: $SESSION"
echo "every error response above should be a normal content block whose JSON"
echo "payload starts with an \"error\" field (conflict, not_found, already_exists,"
echo "forbidden_path, invalid_path). isError must NOT be true on any of them."
