#!/usr/bin/env bash
# PRODUCTION-SHAPED kernel E2E (the kernel-server-runtime-e2e task's packed-path
# proof): server sweep/dispatch -> machine poll -> kernel delivery -> the REAL
# SHIPPED loopany-kernel CLI callback -> run finish + postcondition + roots jail.
#
# Everything runs the production shape:
#   - the daemon is the npm-PACKED @crewlet/loopany tarball, npm-installed into a
#     temp prefix (real node_modules, real bin links for loopany AND
#     loopany-kernel - the 2026-08-11 review's blocking finding was exactly that
#     the packed package had no kernel callback);
#   - the server is the unified TanStack dev server (UI + machine routes +
#     scheduler + kernel gateway, one process, pglite tier);
#   - the "coding agent" is a stub bin (LOOPANY_CLAUDE_BIN) that calls
#     `loopany-kernel` RESOLVED FROM PATH - proving the kernel-run shim dir +
#     the in-run env contract (LOOPANY_KERNEL_BACKEND/TOKEN) end to end.
#
# Five scenarios under ONE daemon session (LOOPANY_ROOTS jail active):
#   bet-e2e     workdir inside the jail; stub notes progress  -> run DONE
#   bet-silent  stub exits 0 writing NOTHING                  -> postcondition FAILED
#   bet-jail    workdir OUTSIDE the jail                      -> jail FAILED, no spawn
#   bet-goal    CLOSED GOAL: silent done refuses, done+note completes + pauses cron
#   decide-brand HUMAN HAND-BACK (live, after the daemon is up): the delivered
#               prompt carries the reply in its wake context
# (Offline catch-up is structural: the first three runs are minted BEFORE the
#  daemon starts and are claimed on its first poll.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$ROOT/packages/daemon"

TMP="$(mktemp -d -t loopany-kernel-e2e)"
PORT="${LOOPANY_PORT:-3899}"
BASE="http://127.0.0.1:$PORT"
TOKEN="dk_e2e_kernel_$(date +%s)"
ALIAS="e2e-mbp"

server_pid=""; daemon_pid=""
cleanup() {
  [ -n "$daemon_pid" ] && kill "$daemon_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && { kill "$server_pid" 2>/dev/null; pkill -P "$server_pid" 2>/dev/null; } || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "✗ $1" >&2; exit 1; }

# ---- 1. pack + install the daemon the way npm users get it -------------------
echo "▶ building + packing the daemon ..."
( cd "$DAEMON_DIR" && npx -y pnpm@8.15.0 run build ) >"$TMP/build.log" 2>&1 || { cat "$TMP/build.log"; fail "daemon build"; }
TARBALL="$(cd "$DAEMON_DIR" && npm pack --pack-destination "$TMP" --silent 2>/dev/null | tail -1)"
echo "▶ npm-installing $TARBALL into a temp prefix ..."
( cd "$TMP" && npm install --prefix "$TMP/install" "$TMP/$TARBALL" --omit=dev --no-audit --no-fund ) >"$TMP/install.log" 2>&1 \
  || { tail -20 "$TMP/install.log"; fail "npm install of the packed daemon"; }
BIN="$TMP/install/node_modules/.bin"
[ -x "$BIN/loopany" ] || fail "packed install exposes no loopany bin"
[ -x "$BIN/loopany-kernel" ] || fail "packed install exposes no loopany-kernel bin (the shipped-callback finding)"
"$BIN/loopany-kernel" help >/dev/null || fail "shipped loopany-kernel does not execute"
echo "✓ packed daemon exposes both bins; loopany-kernel executes"

# ---- 2. unified server -------------------------------------------------------
echo "▶ starting the unified server on $BASE ..."
( cd "$ROOT/packages/server" && LOOPANY_PORT="$PORT" LOOPANY_DATA_DIR="$TMP/server-data" \
    LOOPANY_DB_PATH="$TMP/server-data/loopany.db" LOOPANY_LOG_LEVEL=info LOOPANY_KERNEL_SWEEP_MS=2000 \
    LOOPANY_KERNEL_CLAIM_GRACE_MS=3000 LOOPANY_KERNEL_OFFLINE_RECLAIM_MS=5000 \
    npx -y pnpm@8.15.0 dev ) >"$TMP/server.log" 2>&1 &
server_pid=$!
ready=""
for i in $(seq 1 90); do
  if curl -fsS "$BASE/api/bootstrap" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { tail -30 "$TMP/server.log"; fail "server never came up"; }
echo "✓ server up"

# The SHIPPED kernel CLI doubles as our control plane: remote backend via env
# (device credential -> owner surface). This exercises the dk_ kernel bridge too.
lk() { LOOPANY_KERNEL_BACKEND="$BASE" LOOPANY_KERNEL_TOKEN="$TOKEN" "$BIN/loopany-kernel" "$@"; }

# ---- 3. enroll the machine (one clean poll), then seed three tasks -----------
echo "▶ enrolling machine + seeding tasks ..."
curl -fsS -X POST "$BASE/api/machine/poll" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"host\":\"e2e.local\",\"alias\":\"$ALIAS\",\"kernelInFlight\":[]}" >/dev/null

# A create with a DISPATCHABLE assignee mints its assignment run right away
# (dispatch-consequence create), so no explicit `run` is needed.
JAIL="$TMP/work"; mkdir -p "$JAIL/proj"; mkdir -p "$TMP/outside"
lk create "bet e2e"    --id bet-e2e    --assignee "$ALIAS/claude" --workdir "$JAIL/proj"    >/dev/null
lk create "bet silent" --id bet-silent --assignee "$ALIAS/claude" --workdir "$JAIL/proj"    >/dev/null
lk create "bet jail"   --id bet-jail   --assignee "$ALIAS/claude" --workdir "$TMP/outside" >/dev/null
lk create "reach 1k subs" --id bet-goal --assignee "$ALIAS/claude" --workdir "$JAIL/proj" \
  --goal "newsletter reaches 1000 confirmed subscribers" >/dev/null
lk create "decide: variant A or B" --id decide-brand --assignee "tim@x.co" --workdir "$JAIL/proj" >/dev/null
echo "✓ tasks seeded (4 assignment runs pending; decide-brand waits on the human)"

# ---- 4. stub agent + packed daemon ------------------------------------------
# The stub proves the WHOLE in-run contract: `loopany-kernel` comes from PATH
# (the kernel-run shim dir), auth comes from the injected env, and the marker
# records the cwd the agent actually ran in.
# NB the daemon allowlists the child env, so the marker path is BAKED into the
# stub at generation time (an ad-hoc env var would never reach the agent).
STUB="$TMP/stub-claude"
MARKER="$TMP/marker.txt"
GOAL_MARKER="$TMP/goal-marker.txt"
HANDBACK_MARKER="$TMP/handback-marker.txt"
cat > "$STUB" <<EOS
#!/bin/sh
if [ "\$LOOPANY_TASK_ID" = "bet-silent" ]; then
  exit 0   # a silent "success" - the postcondition must catch this
fi
if [ "\$LOOPANY_TASK_ID" = "bet-death" ]; then
  sleep 45   # long enough for the daemon to be killed mid-run
  exit 0
fi
if [ "\$LOOPANY_TASK_ID" = "bet-goal" ]; then
  # A closed goal must REFUSE a silent done ...
  if loopany-kernel update bet-goal status=done >/dev/null 2>&1; then
    echo "UNGUARDED-DONE" >> "$GOAL_MARKER"
  else
    echo "silent-done-refused" >> "$GOAL_MARKER"
  fi
  # ... and complete with the note as evidence.
  loopany-kernel update bet-goal status=done --note "hit 1042 confirmed subscribers" || exit 1
  exit 0
fi
if [ "\$LOOPANY_TASK_ID" = "decide-brand" ]; then
  # The delivered prompt (our argv) must carry the hand-back reply.
  if echo "\$@" | grep -q "hand-back note"; then echo "reply-in-wake-context" >> "$HANDBACK_MARKER"; fi
  echo "\$@" | grep -q "ship variant B" && echo "reply-verbatim" >> "$HANDBACK_MARKER"
  loopany-kernel note decide-brand "acting on the decision" || exit 1
  exit 0
fi
pwd > "$MARKER"
command -v loopany-kernel >> "$MARKER"
loopany-kernel note "\$LOOPANY_TASK_ID" "did the work (stub agent via shipped CLI)" || exit 1
exit 0
EOS
chmod +x "$STUB"

echo "▶ starting the PACKED daemon (foreground, jailed to $JAIL) ..."
mkdir -p "$TMP/home"
HOME="$TMP/home" LOOPANY_MACHINE_ALIAS="$ALIAS" LOOPANY_CLAUDE_BIN="$STUB" \
  LOOPANY_ROOTS="$JAIL" LOOPANY_LOG_LEVEL=info \
  "$BIN/loopany" up --foreground --server-url "$BASE" --api-key "$TOKEN" >"$TMP/daemon.log" 2>&1 &
daemon_pid=$!

# ---- 5. LIVE hand-back while the daemon polls, then wait for all runs --------
sleep 3
echo "▶ handing decide-brand back to the agent (live dispatch) ..."
lk update decide-brand assignee="$ALIAS/claude" status=todo \
  --note "ship variant B - the landing metrics favor it" >/dev/null

echo "▶ waiting for the five runs to settle ..."
settled=""
for i in $(seq 1 90); do
  LOG_E2E="$(lk show bet-e2e --log 2>/dev/null || true)"
  LOG_SILENT="$(lk show bet-silent --log 2>/dev/null || true)"
  LOG_JAIL="$(lk show bet-jail --log 2>/dev/null || true)"
  LOG_GOAL="$(lk show bet-goal --log 2>/dev/null || true)"
  LOG_DECIDE="$(lk show decide-brand --log 2>/dev/null || true)"
  if echo "$LOG_E2E" | grep -q "run-returned" \
     && echo "$LOG_SILENT" | grep -q "run-returned" \
     && echo "$LOG_JAIL" | grep -q "run-returned" \
     && echo "$LOG_GOAL" | grep -q "run-returned" \
     && echo "$LOG_DECIDE" | grep -q "run-returned"; then settled=1; break; fi
  sleep 1
done
[ -n "$settled" ] || { echo "--- daemon.log ---"; tail -30 "$TMP/daemon.log"; fail "runs never settled"; }

# ---- 6. assertions -----------------------------------------------------------
echo "$LOG_E2E" | grep -q "did the work (stub agent via shipped CLI)" \
  || { echo "$LOG_E2E"; fail "bet-e2e: the shipped-CLI note never landed"; }
echo "$LOG_E2E" | grep -q "returned done" \
  || { echo "$LOG_E2E"; fail "bet-e2e: run did not settle done"; }
grep -q "$JAIL/proj" "$MARKER" \
  || { cat "$MARKER"; fail "bet-e2e: agent did not run in the task workdir"; }
grep -q "loopany-kernel" "$MARKER" \
  || { cat "$MARKER"; fail "bet-e2e: loopany-kernel was not PATH-resolvable in the agent env"; }
echo "✓ bet-e2e: workdir + shipped-CLI callback + done"

echo "$LOG_SILENT" | grep -q "returned failed" \
  || { echo "$LOG_SILENT"; fail "bet-silent: silent exit 0 was NOT downgraded"; }
echo "$LOG_SILENT" | grep -q "postcondition" \
  || { echo "$LOG_SILENT"; fail "bet-silent: failure note does not name the postcondition"; }
echo "✓ bet-silent: exit 0 with no evidence settles FAILED (postcondition)"

# The show renderer clips notes to ~100 chars, so assert on the surviving
# prefix: "returned failed: workdir <path…" names the jail refusal.
echo "$LOG_JAIL" | grep -q "returned failed: workdir" \
  || { echo "$LOG_JAIL"; fail "bet-jail: out-of-jail workdir did not fail with the jail note"; }
grep -q "bet-jail" "$MARKER" && fail "bet-jail: the agent SPAWNED despite the jail" || true
echo "✓ bet-jail: LOOPANY_ROOTS jail refused the out-of-jail workdir without spawning"

grep -q "silent-done-refused" "$GOAL_MARKER" \
  || { cat "$GOAL_MARKER" 2>/dev/null; fail "bet-goal: a silent done was NOT refused"; }
grep -q "UNGUARDED-DONE" "$GOAL_MARKER" && fail "bet-goal: silent done slipped through" || true
echo "$LOG_GOAL" | grep -q "hit 1042 confirmed subscribers" \
  || { echo "$LOG_GOAL"; fail "bet-goal: the completion note never landed"; }
echo "$LOG_GOAL" | grep -q "status: done" \
  || { echo "$LOG_GOAL"; fail "bet-goal: the closed goal did not complete"; }
echo "✓ bet-goal: closed-goal contract (silent done refused; done+note completes)"

grep -q "reply-in-wake-context" "$HANDBACK_MARKER" \
  || { cat "$HANDBACK_MARKER" 2>/dev/null; fail "decide-brand: the delivered prompt carried no hand-back note"; }
grep -q "reply-verbatim" "$HANDBACK_MARKER" \
  || { cat "$HANDBACK_MARKER" 2>/dev/null; fail "decide-brand: the reply text was not verbatim"; }
echo "$LOG_DECIDE" | grep -q "acting on the decision" \
  || { echo "$LOG_DECIDE"; fail "decide-brand: the follow-on pass never ran"; }
echo "✓ decide-brand: live hand-back dispatched with the reply in the wake context"

TL="$(lk timeline --since 2020-01-01T00:00:00.000Z 2>/dev/null || true)"
echo "$TL" | grep -q "run-activity\|run-failed" \
  || { echo "$TL" | head -10; fail "timeline: no collapsed run items over the remote backend"; }
echo "✓ timeline: the remote bounded endpoint projects the day's runs"

# ---- 7. DAEMON DEATH recovery + duplicate-sweep dedup (packed) ---------------
# bet-death: a slow run gets claimed, then the daemon is KILLED mid-run. The
# server's offline reclaim (threshold 5s here, sweep 2s) must settle it failed.
# bet-cron: a every-minute cron fires while the daemon is DEAD - repeated 2s
# sweeps over the same fire must mint EXACTLY ONE pending run (dedup + the
# active-run guard), proving duplicate sweeps are idempotent in packed shape.
echo "▶ daemon-death recovery: seeding a slow run + an every-minute cron ..."
lk create "bet death" --id bet-death --assignee "$ALIAS/claude" --workdir "$JAIL/proj" >/dev/null
lk create "bet cron"  --id bet-cron  --assignee "$ALIAS/claude" --workdir "$JAIL/proj" \
  --cron "* * * * *" --status in-progress >/dev/null

claimed=""
for i in $(seq 1 30); do
  if lk show bet-death --log 2>/dev/null | grep -q "run-started"; then claimed=1; break; fi
  sleep 1
done
[ -n "$claimed" ] || { tail -20 "$TMP/daemon.log"; fail "bet-death was never claimed"; }
echo "▶ killing the daemon mid-run (pid $daemon_pid) ..."
kill -9 "$daemon_pid" 2>/dev/null || true
daemon_pid=""

reclaimed=""
for i in $(seq 1 40); do
  LOG_DEATH="$(lk show bet-death --log 2>/dev/null || true)"
  if echo "$LOG_DEATH" | grep -q "returned failed"; then reclaimed=1; break; fi
  sleep 1
done
[ -n "$reclaimed" ] || { echo "$LOG_DEATH"; fail "bet-death: the dead daemon's run was never reclaimed"; }
echo "$LOG_DEATH" | grep -q "offline past the reclaim window" \
  || { echo "$LOG_DEATH"; fail "bet-death: reclaim note does not name the offline window"; }
echo "✓ bet-death: daemon killed mid-run -> offline reclaim settled the run failed"

echo "▶ duplicate-sweep dedup: waiting for a cron fire under the dead daemon ..."
minted=""
for i in $(seq 1 75); do
  COUNT="$(curl -fsS -X POST "$BASE/api/kernel/cli" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"read":true}' \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for r in d.get('snapshot',{}).get('runs',[]) if r.get('taskId')=='bet-cron'))")"
  if [ "$COUNT" != "0" ]; then minted="$COUNT"; sleep 8; break; fi
  sleep 1
done
[ -n "$minted" ] || fail "bet-cron: the cron never fired"
FINAL_COUNT="$(curl -fsS -X POST "$BASE/api/kernel/cli" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"read":true}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for r in d.get('snapshot',{}).get('runs',[]) if r.get('taskId')=='bet-cron'))")"
[ "$FINAL_COUNT" = "1" ] || fail "bet-cron: expected exactly 1 run after repeated sweeps over one fire, got $FINAL_COUNT"
echo "✓ bet-cron: ~5+ duplicate 2s sweeps over one fire minted exactly one run"

echo
echo "✅ production-shaped kernel E2E passed: packed daemon, shipped CLI callback,"
echo "   workdir execution, postcondition, roots jail, closed goal, live hand-back,"
echo "   remote timeline, daemon-death reclaim, duplicate-sweep dedup."
