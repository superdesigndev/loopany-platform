#!/usr/bin/env bash
# Cookie loop e2e against the UNIFIED TanStack server (pnpm dev) — the real
# product server: UI + server fns + machine routes + in-process scheduler, ONE
# process. Seeds through the AUTHENTICATED device-token machine surface (the
# same one the daemon uses; the old unauthenticated /api/admin backdoor is gone):
#   1. the daemon self-registers via POST /api/machine/poll (open by design),
#   2. the loop is created via POST /api/machine/loop (runs once immediately),
#   3. the result is read back via GET /api/machine/log.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/packages/server"
DAEMON_CLI="$ROOT/packages/daemon/dist/cli.js"

TMP="$(mktemp -d -t loopany-cookieU)"
PORT="${LOOPANY_PORT:-3877}"
BASE="http://127.0.0.1:$PORT"
TOKEN="dk_demo_cookie_unified"

server_pid=""; daemon_pid=""
cleanup() {
  [ -n "$daemon_pid" ] && kill "$daemon_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && { kill "$server_pid" 2>/dev/null; pkill -P "$server_pid" 2>/dev/null; } || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Device-token machine API (Bearer auth — the daemon's own credential).
machine_get()  { curl -fsS "$BASE$1" -H "Authorization: Bearer $TOKEN"; }
machine_post() { curl -fsS -X POST "$BASE$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"; }

echo "▶ temp data dir: $TMP"
echo "▶ starting unified server (pnpm dev) on $BASE ..."
( cd "$SERVER_DIR" && LOOPANY_PORT="$PORT" LOOPANY_DATA_DIR="$TMP" LOOPANY_DB_PATH="$TMP/loopany.db" LOOPANY_LOG_LEVEL=info \
    pnpm dev ) >"$TMP/server.log" 2>&1 &
server_pid=$!

echo "▶ waiting for the server routes ..."
ready=""
for i in $(seq 1 80); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "server died:"; tail -30 "$TMP/server.log"; exit 1; fi
done
[ -n "$ready" ] || { echo "server route not responding:"; tail -30 "$TMP/server.log"; exit 1; }

# LOOPANY_HOME keeps the demo identity in $TMP so the daemon never clobbers a
# real ~/.loopany device token / server URL on this machine.
echo "▶ starting daemon → $BASE (self-registers the machine on first poll)"
LOOPANY_HOME="$TMP/loopany-home" LOOPANY_TOKEN="$TOKEN" LOOPANY_SERVER_URL="$BASE" LOOPANY_POLL_MS=2000 \
  node "$DAEMON_CLI" >"$TMP/daemon.log" 2>&1 &
daemon_pid=$!

echo "▶ waiting for the machine to register ..."
ONLINE=""
for i in $(seq 1 30); do
  ONLINE="$(machine_get /api/machine/status 2>/dev/null | node -e 'console.log(String(JSON.parse(require("fs").readFileSync(0)).online))' 2>/dev/null || true)"
  [ "$ONLINE" = "true" ] && break
  sleep 1
  if ! kill -0 "$daemon_pid" 2>/dev/null; then echo "daemon died:"; tail -30 "$TMP/daemon.log"; exit 1; fi
done
[ "$ONLINE" = "true" ] || { echo "machine never came online:"; tail -30 "$TMP/daemon.log"; exit 1; }

echo "▶ creating loop 'Cookie每日早餐报告' (runs once immediately on create)"
read -r -d '' TASK <<'EOF' || true
你是 Cookie，一只热爱美食、贴心的小助手。每天早上为主人生成一份「今日早餐报告」：
结合当前季节与营养均衡，推荐一份具体的中式早餐搭配（主食 + 蛋白 + 果蔬 + 一杯饮品），
并在结尾附一句温暖的早安寄语。整体控制在 5 行以内，用中文，语气轻松温暖。
EOF
LOOP_ID="$(node -e '
  process.stdout.write(JSON.stringify({name:"Cookie每日早餐报告",cron:"0 8 * * *",task:process.argv[1],notify:"always"}));
' "$TASK" | { read -r payload; machine_post /api/machine/loop "$payload"; } | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')"
echo "  loop: $LOOP_ID"

echo "▶ waiting for the run to complete ..."
PHASE=""
for i in $(seq 1 90); do
  PHASE="$(machine_get "/api/machine/log?loopId=$LOOP_ID&limit=1" 2>/dev/null | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(r.runs?.[0]?.phase ?? "")' 2>/dev/null || true)"
  [ "$PHASE" = "done" ] || [ "$PHASE" = "error" ] && break
  sleep 2
done

echo; echo "════════════ RESULT (unified TanStack server) ════════════"
machine_get "/api/machine/log?loopId=$LOOP_ID&limit=1" | node -e '
  const body = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const r = body.runs?.[0]; // newest-first
  if (!r) { console.log("(no run)"); process.exit(0); }
  for (const k of ["phase","outcome","status","durationMs","error","sessionId"]) console.log(k.padEnd(9),":",r[k] ?? "—");
  console.log("──────── message ────────"); console.log(r.message ?? "(none)");
'
echo "══════════════════════════════════════════════════════════"
echo; echo "(daemon log tail:)"; tail -6 "$TMP/daemon.log" || true
[ "$PHASE" = "done" ] || { echo "❌ phase=$PHASE"; echo "(server log tail:)"; tail -20 "$TMP/server.log"; exit 1; }
echo "✅ Cookie每日早餐报告 ran end-to-end through the unified product server."
