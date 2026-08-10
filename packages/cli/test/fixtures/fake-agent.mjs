#!/usr/bin/env node
/**
 * A FAKE coding agent for the M4 spawn E2E (§13). It behaves like a real agent
 * spawned by `tick --spawn`:
 *
 *   1. It receives the CORE prompt (on stdin here) and reads it.
 *   2. It drives the REAL `loopany-kernel` CLI as an agent — stamped with the
 *      run's session via LOOPANY_SESSION_ID (the CLI promotes any call carrying
 *      a session to agent-run provenance), so its `note`/`update` events carry
 *      the same sessionId the spawn captured on the run.
 *   3. It notes progress, then closes the task with `update status=done --note …`
 *      (there is NO terminal verb — the status IS the ending, §4).
 *
 * The bin path + workspace cwd arrive via env (LOOPANY_BIN / LOOPANY_WS_CWD) so
 * the fixture never hard-codes a path. It exits 0 on success — the code the spawn
 * host turns into run-finish outcome=done.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const prompt = readStdin();
const taskId = process.env.LOOPANY_TASK_ID;
const sessionId = process.env.LOOPANY_SESSION_ID;
const bin = process.env.LOOPANY_BIN;
const wsCwd = process.env.LOOPANY_WS_CWD;

if (!taskId || !bin || !wsCwd) {
  process.stderr.write("fake-agent: missing LOOPANY_TASK_ID / LOOPANY_BIN / LOOPANY_WS_CWD\n");
  process.exit(2);
}

// Sanity: the prompt must name the task and carry the protocol. A real agent
// reads it; the fixture asserts it actually arrived so a broken delivery fails
// the run (exit non-zero) rather than passing blindly.
if (!prompt.includes(taskId) || !prompt.includes("one pass")) {
  process.stderr.write("fake-agent: prompt did not arrive as expected\n");
  process.exit(3);
}

function cli(...argv) {
  const res = spawnSync(process.execPath, [bin, ...argv], {
    cwd: wsCwd,
    encoding: "utf8",
    // The session id is what stamps agent-run provenance on the CLI's events.
    env: { ...process.env, LOOPANY_SESSION_ID: sessionId },
  });
  if (res.status !== 0) {
    process.stderr.write(`fake-agent: \`${argv.join(" ")}\` exited ${res.status}: ${res.stderr}\n`);
    process.exit(4);
  }
  return res.stdout;
}

// 1. Read the task (open by reading).
cli("show", taskId, "--log");
// 2. Note progress.
cli("note", taskId, "fake agent did the work");
// 3. Close by writing status (the ending IS the status).
cli("update", taskId, "status=done", "--note", "completed by fake agent");

process.exit(0);
