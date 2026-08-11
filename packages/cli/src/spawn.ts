/**
 * `tick --spawn` — the LOCAL agent loop (§5.2 "run 由宿主消费：local = tick
 * --spawn"). The clock's `tick` only creates run(pending); this host consumes
 * them: for each pending run it CLAIMS the run (pending -> running, sessionId
 * captured), renders the CORE prompt, spawns the profile command for the run's
 * assignee, waits, and FINISHES the run from the child's exit code (0 -> done,
 * non-zero -> failed).
 *
 * Assignee resolution lands here (§5.3): config.json `profiles` map an assignee
 * name -> {cmd, args, cwd}. This is the local driver's "解析梯子" — a pending run
 * whose assignee has no profile is left pending (a person's inbox item, or an
 * unconfigured agent), never spawned headless.
 *
 * The process spawn is an INJECTABLE seam (`SpawnFn`): tests drive a fake agent
 * with no real subprocess, and a real `tick --spawn` passes the node child_process
 * seam. The whole module is otherwise I/O-shaped only through the driver (the same
 * runCommand/lock every verb uses) so a spawn is one atomic claim, one wait, one
 * atomic finish.
 */
import {
  type KernelEvent,
  type Provenance,
  type RunRecord,
  type Snapshot,
  type TaskObject,
} from "@loopany/kernel";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DriverError, loadEvents, loadSnapshot, readConfig, runCommand } from "./driver.js";
import { buildCorePromptForRun, wakeReasonFor } from "./prompt.js";

// ---- config profiles (§5.3 local resolution ladder) ----

/** One executor binding: how to launch the agent for an assignee. `args` is a
 *  template — the token `{{prompt}}` (if present) is replaced by the CORE prompt
 *  on argv; otherwise the prompt is written to the child's stdin. `cwd` is where
 *  the agent runs (its repo). */
export interface Profile {
  cmd: string;
  args?: readonly string[];
  cwd?: string;
}

/** The `profiles` block of config.json: assignee name -> Profile. Absent = no
 *  profiles configured (every agent run stays pending). */
export type Profiles = Readonly<Record<string, Profile>>;

const PROMPT_TOKEN = "{{prompt}}";

/** Read profiles from config.json (`profiles` key). A missing/empty block is an
 *  empty map, not an error — an unconfigured workspace simply spawns nothing. A
 *  malformed profile (missing `cmd`) is a loud BAD_CONFIG rather than a silent
 *  skip, so a typo never quietly leaves a run un-run. */
export function readProfiles(wsDir: string): Profiles {
  const cfg = readConfig(wsDir) as unknown as { profiles?: unknown };
  const raw = cfg.profiles;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DriverError("BAD_CONFIG", "config.json `profiles` must be an object of name -> {cmd,args,cwd}");
  }
  const out: Record<string, Profile> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) {
      throw new DriverError("BAD_CONFIG", `profile "${name}" must be an object with a "cmd"`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.cmd !== "string" || p.cmd.length === 0) {
      throw new DriverError("BAD_CONFIG", `profile "${name}" is missing a string "cmd"`);
    }
    if (p.args !== undefined && !(Array.isArray(p.args) && p.args.every((a) => typeof a === "string"))) {
      throw new DriverError("BAD_CONFIG", `profile "${name}" `+ '`args` must be an array of strings');
    }
    if (p.cwd !== undefined && typeof p.cwd !== "string") {
      throw new DriverError("BAD_CONFIG", `profile "${name}" \`cwd\` must be a string`);
    }
    out[name] = {
      cmd: p.cmd,
      ...(p.args !== undefined ? { args: p.args as string[] } : {}),
      ...(p.cwd !== undefined ? { cwd: p.cwd as string } : {}),
    };
  }
  return out;
}

// ---- the injectable process seam ----

/** What the host passes the child. `promptOnArgv` is non-null when the profile's
 *  args carried a `{{prompt}}` token (the prompt goes on argv); otherwise `input`
 *  carries it for stdin delivery. `env` carries the run's ambient identity
 *  (LOOPANY_TASK_ID / _RUN_ID / _SESSION_ID) so the agent can call back with the
 *  right session. */
export interface SpawnRequest {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** The prompt to write to stdin, or undefined when it rode on argv. */
  input?: string;
}

/** The result the host reads back: an exit code drives done|failed. */
export interface SpawnResult {
  status: number;
  /** Optional captured output — surfaced in the notice, never parsed. */
  stdout?: string;
  stderr?: string;
}

export type SpawnFn = (req: SpawnRequest) => SpawnResult;

/** The default seam: a real synchronous subprocess. Inherit nothing sensitive —
 *  pass an explicit env (the run identity plus the caller's PATH/HOME so the agent
 *  binary resolves). stdin gets the prompt when it did not ride on argv. */
export const realSpawn: SpawnFn = (req) => {
  const child = spawnSync(req.cmd, [...req.args], {
    cwd: req.cwd,
    env: req.env,
    input: req.input,
    encoding: "utf8",
  });
  if (child.error) {
    // A launch failure (ENOENT on the cmd) is a failed run, not a thrown host —
    // report a non-zero status the finish path turns into outcome=failed.
    return { status: 127, stderr: child.error.message };
  }
  return { status: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
};

/** True when the task's workdir exists AND is a directory on THIS machine.
 *  A file at the path is as broken as an absent dir - both fail the run loud. */
export function workdirExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---- one run's spawn (claim -> spawn -> finish) ----

/** A generated session id for a run whose claim did not carry one. The agent
 *  reads it back via LOOPANY_SESSION_ID so its own callbacks (note/update) stamp
 *  the same session on the event stream (§3 provenance · §7 rung ⑤). Derived from
 *  the run id so it is stable and needs no randomness. */
function sessionIdFor(run: RunRecord): string {
  return `spawn-${run.id}`;
}

export interface SpawnedRun {
  runId: string;
  taskId: string;
  assignee: string;
  outcome: "done" | "failed";
  status: number;
}

/** One notice per outcome (fired-and-finished / skipped). */
export interface SpawnReport {
  spawned: SpawnedRun[];
  notices: string[];
}

/** Consume every PENDING run in the workspace: claim, spawn its profile, finish.
 *  The host actor is `{entrance:"agent-run", actorId: runId, sessionId}` — the
 *  run itself is the actor of its own claim/finish events. Runs whose assignee has
 *  no profile are LEFT pending with a notice (never spawned).
 *
 *  `spawn` is injected (tests pass a fake agent). `env` is the ambient process env
 *  the child inherits on top of the run-identity keys. */
export function spawnPendingRuns(
  wsDir: string,
  now: string,
  spawn: SpawnFn,
  baseEnv: Record<string, string | undefined> = {},
  /** The CLI invocation the CORE prompt teaches (see resolveSelfBin). Defaults
   *  to the bare PATH name so tests stay stable. */
  bin?: string,
): SpawnReport {
  const profiles = readProfiles(wsDir);
  const snapshot = loadSnapshot(wsDir);
  const pending = snapshot.runs.filter((r) => r.state === "pending");
  const spawned: SpawnedRun[] = [];
  const notices: string[] = [];

  for (const run of pending) {
    const task = snapshot.objects[run.taskId];
    if (!task || task.archetype !== "task") {
      notices.push(`run ${run.id} points at missing task ${run.taskId} — skipped`);
      continue;
    }
    const assignee = run.assignee;
    if (assignee === null) {
      notices.push(`run ${run.id} has no assignee — skipped`);
      continue;
    }
    const profile = profiles[assignee];
    if (profile === undefined) {
      notices.push(`run ${run.id}: no profile for assignee "${assignee}" — left pending`);
      continue;
    }
    const result = spawnOne(wsDir, run, task, profile, now, spawn, baseEnv, bin);
    spawned.push(result);
    notices.push(
      `run ${run.id} (${assignee}) ${result.outcome} (exit ${result.status})`,
    );
  }
  return { spawned, notices };
}

function spawnOne(
  wsDir: string,
  run: RunRecord,
  task: TaskObject,
  profile: Profile,
  now: string,
  spawn: SpawnFn,
  baseEnv: Record<string, string | undefined>,
  bin?: string,
): SpawnedRun {
  const sessionId = sessionIdFor(run);
  const actor: Provenance = { entrance: "agent-run", actorId: run.id, sessionId };

  // CLAIM: pending -> running, sessionId captured on the run + the task's stream.
  runCommand(wsDir, { op: "run-claim", runId: run.id, sessionId }, actor, now);

  // Render the CORE prompt against a FRESH snapshot (the claim just flipped the
  // task's status; the agent should see the post-claim state).
  const claimed = loadSnapshot(wsDir);
  const claimedTask = (claimed.objects[task.id] as TaskObject | undefined) ?? task;
  const claimedRun = claimed.runs.find((r) => r.id === run.id) ?? run;
  const hasHistory = hasMeaningfulHistory(wsDir, task.id, run.id, claimed);
  const prompt = buildCorePromptForRun(
    claimedRun,
    claimedTask,
    wakeReasonFor(claimedRun, claimedTask),
    hasHistory,
    bin,
  );

  // The task's workdir (absolute, machine-local) is where the agent session
  // starts; missing = FAIL LOUD as a failed run with a clear note - never a
  // silent fallback to the workspace root (owner decision: a loop working in
  // another project's checkout must not quietly run somewhere else).
  if (claimedTask.workdir !== null && !workdirExists(claimedTask.workdir)) {
    const note = `workdir does not exist on this machine: ${claimedTask.workdir}`;
    runCommand(wsDir, { op: "run-finish", runId: run.id, outcome: "failed", note }, actor, now);
    return { runId: run.id, taskId: task.id, assignee: run.assignee ?? "", outcome: "failed", status: 127 };
  }
  const req = buildSpawnRequest(profile, prompt, run, task, sessionId, baseEnv, wsDir, claimedTask.workdir ?? undefined);
  let res = spawn(req);
  let retried = false;
  if (res.status !== 0) {
    // ONE immediate retry - the cheapest transient shield (a stalled stream, a
    // single 5xx; haiku-5 died to exactly this). Anything that survives it
    // reaches the kernel's bounded re-arm/park policy via run-finish(failed).
    retried = true;
    res = spawn(req);
  }
  const outcome: "done" | "failed" = res.status === 0 ? "done" : "failed";

  // FINISH: running -> done|failed. The note carries the exit code + any captured
  // stderr tail so a failed run leaves a breadcrumb on the stream.
  const note =
    outcome === "done"
      ? `agent run completed (exit 0${retried ? ", after one retry" : ""})`
      : `agent run failed (exit ${res.status}, incl. one retry)${res.stderr ? `: ${clipTail(res.stderr)}` : ""}`;
  runCommand(wsDir, { op: "run-finish", runId: run.id, outcome, note }, actor, now);

  return { runId: run.id, taskId: task.id, assignee: run.assignee ?? "", outcome, status: res.status };
}

/** Whether the task has MEANINGFUL prior history — the signal that separates the
 *  `reassigned` scenario (a human re-queued already-done work: trust it, don't
 *  redo it) from `new-task` (a fresh task's first pass). On the real spawn path
 *  the events file ALWAYS exists (creation writes `created`, and the just-claimed
 *  run appended `run-started` + a `status-changed`), so a bare existsSync would
 *  force `reassigned` for EVERY assignment/manual run and make the new-task
 *  scenario dead code (M4 fix). We therefore look past the bootstrapping noise:
 *
 *   - any PRIOR finished run for this task (a completed earlier pass), or
 *   - any stream event that only a prior pass or a human could have written —
 *     everything EXCEPT `created` (the birth) and this run's own claim events
 *     (`run-started`, plus the todo->in-progress `status-changed` the claim wrote).
 *
 *  A first-pass task has neither, so it correctly reads as `new-task`. */
function hasMeaningfulHistory(wsDir: string, taskId: string, runId: string, snapshot: Snapshot): boolean {
  // A prior run that already finished (or was superseded) is unambiguous history.
  const priorFinishedRun = snapshot.runs.some(
    (r) => r.taskId === taskId && r.id !== runId && (r.state === "done" || r.state === "failed" || r.state === "superseded"),
  );
  if (priorFinishedRun) return true;

  const events = loadEvents(wsDir, taskId);
  return events.some(isMeaningfulHistoryEvent);
}

/** True for a stream event that proves prior work — i.e. anything a first pass's
 *  own claim (or the task's birth) did NOT write. `created`, a `run-started`, and
 *  the claim's todo->in-progress `status-changed` are the only events guaranteed
 *  present on a genuine first pass, so they are excluded. */
function isMeaningfulHistoryEvent(e: KernelEvent): boolean {
  if (e.kind === "created") return false;
  if (e.kind === "run-started") return false; // this run's own claim (or a prior run — either way, run-returned settles it)
  if (e.kind === "status-changed") {
    // The claim writes a todo->in-progress status-changed; ANY other transition
    // (e.g. the once fire's follow-up->todo, or a human re-queue) is real history.
    const to = e.diff?.status?.new;
    const from = e.diff?.status?.old;
    return !(from === "todo" && to === "in-progress");
  }
  // note / observation / doc-updated / assignee-changed / fields-changed /
  // run-returned / trigger-discarded — all require a prior pass or a human.
  return true;
}

/** The CLI invocation the CORE prompt should teach the spawned agent. A child
 *  shell may REBUILD its PATH from scratch (a login-shell zprofile under a fake
 *  HOME rebuilt codex's PATH and orphaned the bare `loopany-kernel` name -
 *  while claude only ever found it through the runner's transient npx PATH
 *  entry, the same trap the daemon's resolveDurableCommand exists for). So the
 *  durable form is ABSOLUTE: "<abs node> <abs entry>" when we are running from
 *  a script, the bare name only as the last resort. LOOPANY_BIN overrides. */
export function resolveSelfBin(
  env: Record<string, string | undefined> = process.env,
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  if (env.LOOPANY_BIN) return env.LOOPANY_BIN;
  if (argv1 && argv1.includes("loopany-kernel")) return `${execPath} ${argv1}`;
  return "loopany-kernel";
}

/** Build the child request: env carries the run identity, and the prompt goes on
 *  argv (if the profile args named `{{prompt}}`) or via stdin. */
export function buildSpawnRequest(
  profile: Profile,
  prompt: string,
  run: RunRecord,
  task: TaskObject,
  sessionId: string,
  baseEnv: Record<string, string | undefined>,
  wsDir: string,
  /** Absolute spawn cwd override (task.workdir); defaults to the workspace. */
  cwd?: string,
): SpawnRequest {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;
  env.LOOPANY_TASK_ID = task.id;
  env.LOOPANY_RUN_ID = run.id;
  env.LOOPANY_SESSION_ID = sessionId;
  // The agent's own note/status-changed callbacks must be attributed to the RUN,
  // not the generic "agent" default (§3: Provenance.actorId is userId|runId|
  // triggerId, captured at write time and unreconstructable later). resolveActor
  // (cli.ts) prefers LOOPANY_ACTOR when a session is present, so seeding it with
  // the run id makes every callback carry actorId=run-<id>, matching the host's
  // own claim/finish events.
  env.LOOPANY_ACTOR = run.id;

  const argsTemplate = profile.args ?? [];
  const onArgv = argsTemplate.includes(PROMPT_TOKEN);
  const args = onArgv ? argsTemplate.map((a) => (a === PROMPT_TOKEN ? prompt : a)) : [...argsTemplate];

  return {
    cmd: profile.cmd,
    args,
    // Default the agent's cwd to the workspace's parent (the repo root holding
    // .loopany/) when the profile does not pin one.
    // task.workdir wins (the loop works in another project); then the
    // profile-level cwd; then the workspace root.
    cwd: cwd ?? profile.cwd ?? repoRootOf(wsDir),
    env,
    ...(onArgv ? {} : { input: prompt }),
  };
}

/** The repo root holding a `.loopany/` dir is its parent. */
function repoRootOf(wsDir: string): string {
  return join(wsDir, "..");
}

function clipTail(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? "…" + flat.slice(flat.length - max) : flat;
}
