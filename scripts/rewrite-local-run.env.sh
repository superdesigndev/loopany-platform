#!/usr/bin/env bash
# Local REAL-EXECUTION environment for the rewrite (kernel) line — landing unit 10.
#
# Source this, never run it: `source scripts/rewrite-local-run.env.sh`.
#
# It defines an ISOLATED stack — its own port, its own pglite data dir and its own
# LOOPANY_HOME — so nothing here can reach the production `~/.loopany` daemon that
# a bare `loopany` command drives. Override LOOPANY_RW_BASE / LOOPANY_PORT to run a
# second isolated stack side by side.
#
# Full recipe (registration, daemon start/stop, smoke loop): packages/server/AGENTS.md,
# "Real local execution on the rewrite line".

# --- where this stack's state lives (nothing under ~/.loopany) ---
export LOOPANY_RW_BASE="${LOOPANY_RW_BASE:-$HOME/.loopany-rw10}"
export LOOPANY_DATA_DIR="$LOOPANY_RW_BASE/data"   # server: pglite database dir
export LOOPANY_HOME="$LOOPANY_RW_BASE/home"       # daemon: device token, pidfile, callback bin
export LOOPANY_DB=pglite                          # embedded tier; no DATABASE_URL
# The smoke loop (scripts/rewrite-smoke-loop.md) BINDS this directory, and a bound
# workdir is never created by the daemon — a run whose directory is missing fails
# loudly by design. Creating it here is what makes the recipe replayable from
# scratch. NB the smoke artifact hard-codes the DEFAULT base's path, so edit its
# `workdir:` to match if you overrode LOOPANY_RW_BASE.
export LOOPANY_RW_SCRATCH="$LOOPANY_RW_BASE/scratch"
mkdir -p "$LOOPANY_DATA_DIR" "$LOOPANY_HOME" "$LOOPANY_RW_SCRATCH"

# --- the rewrite cutover flag, on BOTH sides ---
# Server: arms the kernel clock + run queue. Daemon: claims via /api/agent/runs/claim
# instead of the legacy /api/machine/poll. They must agree.
export LOOPANY_RUNS_V2=1

# --- addresses ---
export LOOPANY_PORT="${LOOPANY_PORT:-3137}"       # NOT 3000: that is the demo stack
export LOOPANY_SERVER_URL="http://127.0.0.1:$LOOPANY_PORT"

# --- the device credential this stack's machine is derived from ---
# The machine id is sha256(token)-derived, so a stable token means a stable machine
# across restarts. Minted once and kept beside the rest of this stack's state.
if [ ! -f "$LOOPANY_RW_BASE/device-token" ]; then
  printf 'dk_%s' "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')" \
    > "$LOOPANY_RW_BASE/device-token"
  chmod 600 "$LOOPANY_RW_BASE/device-token"
fi
export LOOPANY_TOKEN="$(cat "$LOOPANY_RW_BASE/device-token")"

echo "rewrite local stack: $LOOPANY_SERVER_URL  data=$LOOPANY_DATA_DIR  home=$LOOPANY_HOME  scratch=$LOOPANY_RW_SCRATCH"
