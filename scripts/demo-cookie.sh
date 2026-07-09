#!/usr/bin/env bash
# End-to-end demo: the "Cookie每日早餐报告" loop, server → daemon → claude → report.
# Boots a standalone server (temp DB), registers a machine, creates the loop,
# fires it now, starts the daemon, and waits for the run to finish — printing the
# breakfast report claude produced. Cleans up both processes on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/packages/server"
DAEMON_CLI="$ROOT/packages/daemon/dist/cli.js"

TMP="$(mktemp -d -t adscaile-cookie)"
PORT="${ADSCAILE_PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
TOKEN="dk_demo_cookie"

server_pid=""
daemon_pid=""
cleanup() {
  [ -n "$daemon_pid" ] && kill "$daemon_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "▶ temp data dir: $TMP"

# 1) start server (migrates on boot via ensureServer)
( cd "$SERVER_DIR" && ADSCAILE_DATA_DIR="$TMP" ADSCAILE_DB_PATH="$TMP/adscaile.db" ADSCAILE_PORT="$PORT" \
    pnpm exec tsx src/main.ts ) >"$TMP/server.log" 2>&1 &
server_pid=$!

echo "▶ waiting for server on $BASE ..."
for i in $(seq 1 40); do
  if curl -fsS "$BASE/api/machines" >/dev/null 2>&1; then break; fi
  sleep 0.5
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "server died:"; cat "$TMP/server.log"; exit 1; fi
done

# 2) register the machine (id derives from the token)
echo "▶ registering machine"
curl -fsS -X POST "$BASE/api/machines" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Demo Mac\",\"token\":\"$TOKEN\"}" | tee "$TMP/machine.json"; echo
MACHINE_ID="$(node -e "console.log(require('$TMP/machine.json').machine.id)")"

# 3) create the Cookie loop, due now
echo "▶ creating loop 'Cookie每日早餐报告'"
read -r -d '' TASK <<'EOF' || true
你是 Cookie，一只热爱美食、贴心的小助手。每天早上为主人生成一份「今日早餐报告」：
结合当前季节与营养均衡，推荐一份具体的中式早餐搭配（主食 + 蛋白 + 果蔬 + 一杯饮品），
并在结尾附一句温暖的早安寄语。整体控制在 5 行以内，用中文，语气轻松温暖。
EOF
curl -fsS -X POST "$BASE/api/loops" -H 'Content-Type: application/json' -d "$(node -e '
  const task = process.argv[1];
  process.stdout.write(JSON.stringify({
    name: "Cookie每日早餐报告",
    machineId: process.argv[2],
    cron: "0 8 * * *",
    task,
    notify: "always",
    nextRunAt: new Date().toISOString()
  }));
' "$TASK" "$MACHINE_ID")" | tee "$TMP/loop.json"; echo
LOOP_ID="$(node -e "console.log(require('$TMP/loop.json').loop.id)")"
echo "  loop id: $LOOP_ID"

# 4) start the daemon (unrestricted roots → scratch workdir)
echo "▶ starting daemon"
ADSCAILE_TOKEN="$TOKEN" ADSCAILE_SERVER_URL="$BASE" ADSCAILE_POLL_MS=2000 \
  node "$DAEMON_CLI" >"$TMP/daemon.log" 2>&1 &
daemon_pid=$!

# 5) wait for the run to finish
echo "▶ waiting for the run to complete (claude is working) ..."
PHASE=""
for i in $(seq 1 90); do
  RUNS="$(curl -fsS "$BASE/api/loops/$LOOP_ID/runs")"
  PHASE="$(node -e "const r=JSON.parse(process.argv[1]); console.log(r[0]?.phase ?? '')" "$RUNS")"
  if [ "$PHASE" = "done" ] || [ "$PHASE" = "error" ]; then break; fi
  sleep 2
done

echo
echo "════════════════════ RESULT ════════════════════"
curl -fsS "$BASE/api/loops/$LOOP_ID/runs" | node -e '
  const runs = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const r = runs[0];
  if (!r) { console.log("(no run recorded)"); process.exit(0); }
  console.log("phase   :", r.phase);
  console.log("outcome :", r.outcome);
  console.log("status  :", r.status);
  console.log("durMs   :", r.durationMs);
  console.log("error   :", r.error ?? "—");
  console.log("session :", r.sessionId ?? "—");
  console.log("──────── message ────────");
  console.log(r.message ?? "(none)");
'
echo "═════════════════════════════════════════════════"
echo
echo "(daemon log tail:)"; tail -8 "$TMP/daemon.log" || true

[ "$PHASE" = "done" ] || { echo "❌ run did not reach 'done' (phase=$PHASE)"; exit 1; }
echo "✅ Cookie每日早餐报告 ran end-to-end."
