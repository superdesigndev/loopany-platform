#!/usr/bin/env node
/**
 * The REPLAY-TIER agent (tier (a) in §4 of the design doc: a scripted replayer,
 * zero-cost, for regression runs). It is spawned by `tick --spawn` exactly like
 * a real coding agent, but instead of thinking it REPLAYS a fixed command
 * sequence keyed by the task it was launched for.
 *
 * Contract (all via env, which spawn.ts threads through):
 *   LOOPANY_TASK_ID     the task this run belongs to (the script lookup key)
 *   LOOPANY_RUN_ID      / LOOPANY_SESSION_ID / LOOPANY_ACTOR - run identity, so
 *                       the CLI callbacks below stamp the right provenance
 *   LOOPANY_NOW         the virtual instant (inherited -> clock propagation into
 *                       every replayed command, the end-to-end determinism proof)
 *   LOOPANY_KERNEL_BIN  the loopany-kernel bin to re-invoke for each command
 *   LOOPANY_REPLAY_SCRIPT  path to a JSON file: { "<key>": [ [argv...], ... ] }
 *
 * A script key is looked up DATE-FIRST: `<taskId>@<YYYY-MM-DD>` (the date parsed
 * from LOOPANY_NOW) wins, else the bare `<taskId>`. A weekly loop that must act
 * differently each fire (open a bet one week, win+scale the next, kill the third)
 * keys its entries by date; a task with the same behavior every run keeps the bare
 * key. Both forms coexist in one script (backward compatible).
 *
 * The CORE prompt arrives on stdin (a real agent would read it); we DRAIN it
 * without parsing. A task with no script entry is a clean no-op (exit 0) - the
 * "nothing to do" agent. Any command failing is surfaced on stderr but does not
 * abort the run (the run's outcome is driven by THIS process's exit code, and a
 * replay is meant to run its full sequence).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Drain stdin (the CORE prompt) so the parent's write never blocks; ignore it.
try {
  readFileSync(0);
} catch {
  /* no stdin piped - fine */
}

const taskId = process.env.LOOPANY_TASK_ID;
const scriptPath = process.env.LOOPANY_REPLAY_SCRIPT;
const bin = process.env.LOOPANY_KERNEL_BIN;

if (!taskId || !scriptPath || !bin) {
  // Missing wiring is a clean no-op, not a crash: the harness controls all three,
  // and a run with no script is legitimately "nothing to do".
  process.exit(0);
}

let script;
try {
  script = JSON.parse(readFileSync(scriptPath, "utf8"));
} catch {
  process.exit(0);
}

// Date-keyed lookup FIRST (`<taskId>@<YYYY-MM-DD>`, date parsed from LOOPANY_NOW),
// then the bare `<taskId>` fallback. A malformed/absent LOOPANY_NOW skips the
// date key and reads the bare one (back-compat).
const now = process.env.LOOPANY_NOW ?? "";
const day = now.slice(0, 10); // YYYY-MM-DD prefix of the ISO instant
const dateKeyed = /^\d{4}-\d{2}-\d{2}$/.test(day) ? script[`${taskId}@${day}`] : undefined;
const sequence = Array.isArray(dateKeyed) ? dateKeyed : script[taskId];
if (!Array.isArray(sequence)) process.exit(0); // no entry for this task = no-op

for (const argv of sequence) {
  if (!Array.isArray(argv)) continue;
  const child = spawnSync(process.execPath, [bin, ...argv], {
    // Inherit our env verbatim (LOOPANY_NOW + the run provenance flow through to
    // the CLI so callbacks stamp the virtual clock + the run's session).
    env: process.env,
    encoding: "utf8",
  });
  if ((child.status ?? 1) !== 0) {
    process.stderr.write(
      `replay-agent: \`${argv.join(" ")}\` exited ${child.status}: ${child.stderr ?? ""}\n`,
    );
  }
}

process.exit(0);
