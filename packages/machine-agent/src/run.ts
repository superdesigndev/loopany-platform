/**
 * EXECUTING AN INSTRUCTION - the runs bridge's machine half.
 *
 * Captain decision 12 makes "an agent does it from an instruction" the DEFAULT path
 * for every external effect, and this module is that path: it takes an
 * INTENT + CONTEXT + SCOPE work order, checks it deterministically, spawns the
 * configured executor with the composed instruction on stdin, and reports what
 * happened. It knows nothing about pull requests, Intercom or tweets - which is the
 * whole point. Adding an action kind adds a declaration, not code here.
 *
 * ── the shape of the spawn, and every reason for it ─────────────────────────
 *
 *   FIXED ARGV, NO SHELL       `execFile`, never `exec`. Nothing in a work order can
 *                              become a second command - the same discipline
 *                              `gh.ts` uses for a comment body.
 *   INSTRUCTION ON STDIN       the intent is bytes on a pipe, never an argument. A
 *                              prompt containing a quote, a newline or a `$(…)` is
 *                              just text, and `ps` never shows it.
 *   THE WORKDIR IS A JAIL      resolved against `run.root` and re-checked with a
 *                              path-prefix test AFTER normalization, so `../` cannot
 *                              walk out. A work order naming an absolute path must
 *                              still land inside the root.
 *   BOUNDED TIME               the declared timeout, clamped to the machine's own
 *                              maximum, enforced by killing the whole PROCESS GROUP
 *                              (`detached` + `kill(-pid)`) - an executor that
 *                              spawned children must not leave them behind.
 *   BOUNDED OUTPUT             captured output is capped and the cap is REPORTED, so
 *                              a truncated report never reads as a complete one.
 *   ALLOWLISTED ENVIRONMENT    the child gets a named subset of this process's
 *                              environment plus the run's own variables. Nothing is
 *                              inherited wholesale, so an unrelated secret in the
 *                              agent's shell does not travel into a run.
 *
 * ── what the exit code means ────────────────────────────────────────────────
 *
 * Exit 0 is a success and anything else is `RUN_FAILED`; a timeout is `RUN_TIMEOUT`,
 * its own code because "it broke" and "it never finished" send a person to different
 * places. There is deliberately no branch that reads a non-zero exit as success:
 * an effect nobody performed must never be recorded as one that happened.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import type { AgentConfig } from "./config.js";
import { checkRunPermitted, type Refusal } from "./guards.js";
import { RUN_FINDINGS, wantsFinding, type Instruction, type RunFinding } from "./types.js";

/** Environment variables a run inherits. An ALLOWLIST, not a filter: this process's
 *  environment holds the channel token and whatever else the operator's shell had,
 *  and none of that is a run's business. `HOME`/`PATH` are here because an executor
 *  cannot find its own credentials or its own binaries without them - which is
 *  exactly how a coding agent stays logged in without this process handling a token. */
export const INHERITED_ENV = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "TZ",
] as const;

export interface RunOutcomeDetail {
  ok: boolean;
  /** Set when the run did not even start, or was refused. */
  refusal?: Refusal;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Captured stdout+stderr, bounded. */
  output: string;
  truncated: boolean;
  /** The directory the run actually worked in. */
  workdir: string;
}

/** Injectable seams, so every probe drives this without spawning anything real. */
export interface RunDeps {
  /** Spawn the executor and return its outcome. */
  exec: (input: ExecInput) => Promise<ExecResult>;
  /** Make sure a directory exists. Called only for a path already inside the jail. */
  ensureDir: (dir: string) => Promise<void>;
  now: () => number;
}

export interface ExecInput {
  command: string;
  args: string[];
  cwd: string;
  /** The composed instruction, delivered on stdin. */
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

/**
 * Resolve a work order's working directory INSIDE the jail, or refuse.
 *
 * The check is on the NORMALIZED absolute path, with a separator-terminated prefix
 * test - so `/root/../elsewhere` is refused (it normalizes out of the root) and
 * `/root-evil` is refused too (it shares a string prefix with `/root` but is not
 * inside it). Both of those are the mistakes a naive `startsWith` makes.
 */
export function resolveWorkdir(root: string, workdir: string | undefined): { ok: true; dir: string } | { ok: false; why: string } {
  const base = path.resolve(root);
  const target = workdir ? path.resolve(base, workdir) : base;
  const fenced = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(fenced)) {
    return { ok: false, why: `"${workdir}" resolves to ${target}, which is outside this agent's run root ${base}` };
  }
  return { ok: true, dir: target };
}

/**
 * Compose the instruction the executor receives.
 *
 * A PURE function of the work order, so what an agent was told is reproducible from
 * the row - which matters the first time a run does something surprising. Three
 * things ride on top of the intent, and each is here rather than in the declaration
 * because each must be true of EVERY instruction:
 *
 *   THE IDEMPOTENCY DISCIPLINE. Decision 12's own answer to "how is an agent-executed
 *   effect idempotent?": it is not, structurally - it is instruction discipline, with
 *   the observation pipe as the consistency backstop. So every prompt says it, and
 *   says it before the work rather than after.
 *
 *   THE SCOPE, RESTATED. The deterministic guard has already refused an out-of-scope
 *   work order; this tells the agent the boundary it is inside, because an agent that
 *   knows its fence does not spend the run testing it.
 *
 *   THE REPORTING CONTRACT. What the run prints IS the product (the report doc and
 *   the Timeline summary come from it), so the prompt has to say so.
 *
 *   THE FINDING, when the work order declares a path for one. A run's outcome says
 *   whether it worked; only the run can say whether it found anything, and that
 *   answer decides whether a person is asked to look. It is a DECLARED LINE rather
 *   than an inference over prose, because "does this need a human?" must be
 *   answerable without a second model reading the first one's output.
 */
export function composeInstruction(spec: Instruction): string {
  const lines: string[] = [];
  lines.push("# Instruction");
  lines.push("");
  lines.push(spec.intent.trim());
  lines.push("");
  lines.push("# Context");
  lines.push("");
  lines.push("Facts resolved from the workspace graph. This is everything you were given; there is no other source.");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(spec.context, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("# Boundary");
  lines.push("");
  lines.push(`- Work only inside the current directory (${spec.scope.workdir ?? "the run root"}).`);
  lines.push(
    spec.scope.repos.length
      ? `- You may act on these repositories and no others: ${spec.scope.repos.join(", ")}.`
      : "- You have NO repository scope. Do not push, comment on, or otherwise act on any repository.",
  );
  if (spec.scope.writes.length) lines.push(`- Files you are expected to write: ${spec.scope.writes.join(", ")}.`);
  lines.push(`- You have ${Math.round(spec.scope.timeoutMs / 1000)} seconds. Finish inside it.`);
  lines.push("- Never copy a credential, token, key or personal detail into anything you write or publish.");
  lines.push("");
  lines.push("# Before you act");
  lines.push("");
  lines.push(
    "This instruction may be delivered more than once - a lease can expire mid-run and the work order is re-offered.",
  );
  lines.push(
    "So CHECK REALITY FIRST: look at the current state of whatever you are about to change, and if the work has",
  );
  lines.push("already been done, stop and say so. Do not repeat an effect that is already in place.");
  lines.push("");
  lines.push("# Report");
  lines.push("");
  lines.push("Everything you print is the product: it becomes this run's report in the workspace.");
  lines.push("Print short markdown - what you found, what you changed, and anything a person now has to decide.");
  lines.push('If there was nothing to do, say so plainly. A clean stop is a real outcome, not a failure.');
  lines.push("");
  if (wantsFinding(spec)) {
    lines.push("# Your verdict on your own run");
    lines.push("");
    lines.push("End your output with EXACTLY ONE of these lines, on a line of its own and nothing else on it:");
    lines.push("");
    lines.push(`${FINDING_PREFIX} discovery      — you found something a person has to look at or decide`);
    lines.push(`${FINDING_PREFIX} nothing-new    — you looked and there was nothing new; nobody needs to be woken`);
    lines.push("");
    lines.push("This line is how your report reaches a person, so do not omit it and do not invent a third value.");
    lines.push("Say `discovery` only when a HUMAN decision is genuinely needed - a report nobody had to read is");
    lines.push("noise, and noise is how a queue stops being read at all.");
    lines.push("");
  }
  return lines.join("\n");
}

/** The declared line a run prints to report what it found. A literal prefix rather
 *  than prose to be interpreted: this is the one part of a run's output that a
 *  deterministic reader has to be able to trust. */
export const FINDING_PREFIX = "FINDING:";

const FINDING_LINE = /^\s*FINDING:\s*([A-Za-z-]+)\s*$/;

/**
 * Read the run's finding off its output, or nothing.
 *
 * Pure, and deliberately strict in both directions:
 *
 *  - the LAST matching line wins. An agent that revises its verdict mid-run (or
 *    quotes the contract back before answering) means the final declaration, and
 *    reading the first would let a rehearsal outrank the answer.
 *  - a value outside the closed set yields UNDEFINED, never a guess. An unparseable
 *    verdict is a run that did not answer, and the server falls back to the plain
 *    success path - which is quiet. Guessing `discovery` from a typo would put noise
 *    in front of a person; guessing `nothing-new` would hide a real find. Neither is
 *    a decision this parser is entitled to make.
 */
export function readFinding(output: string): RunFinding | undefined {
  let found: RunFinding | undefined;
  for (const line of output.split("\n")) {
    const m = FINDING_LINE.exec(line);
    if (!m) continue;
    const value = m[1]!.toLowerCase();
    if ((RUN_FINDINGS as readonly string[]).includes(value)) found = value as RunFinding;
  }
  return found;
}

/**
 * Run one instruction.
 *
 * The guard sandwich's first half, in order: the caller has already re-checked the
 * approval; this checks what the MACHINE permits, resolves the jail, and only then
 * spawns. The second half - confirming the effect actually landed - is the
 * observation pipe's job, not this function's, which is why nothing here trusts the
 * run's own account of the world.
 */
export async function runInstruction(
  config: AgentConfig,
  spec: Instruction,
  deps: RunDeps,
): Promise<RunOutcomeDetail> {
  const started = deps.now();
  const fail = (refusal: Refusal, workdir = config.run.root ?? ""): RunOutcomeDetail => ({
    ok: false,
    refusal,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: deps.now() - started,
    output: "",
    truncated: false,
    workdir,
  });

  const permitted = checkRunPermitted(config, spec.scope);
  if (permitted) return fail(permitted);

  // Non-null after `checkRunPermitted`, which refuses both when absent.
  const command = config.run.command!;
  const root = config.run.root!;

  const resolved = resolveWorkdir(root, spec.scope.workdir);
  if (!resolved.ok) return fail({ code: "RUN_NOT_PERMITTED", error: resolved.why });

  try {
    await deps.ensureDir(resolved.dir);
  } catch (err) {
    return fail({ code: "AGENT_ERROR", error: `could not prepare ${resolved.dir}: ${errText(err)}` }, resolved.dir);
  }

  const timeoutMs = Math.min(spec.scope.timeoutMs || config.run.maxTimeoutMs, config.run.maxTimeoutMs);
  let result: ExecResult;
  try {
    result = await deps.exec({
      command,
      args: config.run.args,
      cwd: resolved.dir,
      stdin: composeInstruction(spec),
      timeoutMs,
      maxOutputBytes: config.run.maxOutputBytes,
      env: runEnv(spec, resolved.dir),
    });
  } catch (err) {
    // The executor could not be started at all (missing binary, no permission).
    // Retryable: a machine that gets its executor installed will run this fine.
    return fail({ code: "AGENT_ERROR", error: `could not start "${command}": ${errText(err)}` }, resolved.dir);
  }

  const durationMs = deps.now() - started;
  if (result.timedOut) {
    return {
      ok: false,
      refusal: {
        code: "RUN_TIMEOUT",
        error: `the run outlived its ${Math.round(timeoutMs / 1000)}s budget and was killed`,
      },
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: true,
      durationMs,
      output: result.output,
      truncated: result.truncated,
      workdir: resolved.dir,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      refusal: {
        code: "RUN_FAILED",
        error: `the run exited ${result.exitCode ?? "on a signal"}${result.signal ? ` (${result.signal})` : ""}`,
      },
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: false,
      durationMs,
      output: result.output,
      truncated: result.truncated,
      workdir: resolved.dir,
    };
  }
  return {
    ok: true,
    exitCode: 0,
    signal: result.signal,
    timedOut: false,
    durationMs,
    output: result.output,
    truncated: result.truncated,
    workdir: resolved.dir,
  };
}

/** The child's environment: an allowlisted subset of ours plus the run's own facts.
 *  Never a spread of `process.env` - see `INHERITED_ENV`. */
export function runEnv(spec: Instruction, workdir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The run's own identity, so an executor that logs can say which run it was, and
  // an instruction can refer to its workdir without the prompt hard-coding a path.
  env.LOOPANY_RUN_ID = spec.runId;
  env.LOOPANY_RUN_LABEL = spec.label;
  env.LOOPANY_RUN_WORKDIR = workdir;
  return env;
}

/**
 * The real spawn. Detached so the kill takes the whole process GROUP: an executor
 * that started children of its own (a coding agent very much does) must not leave
 * them running past its own timeout.
 */
export function nodeExec(input: ExecInput): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer | string) => {
      if (truncated) return;
      const text = String(chunk);
      const room = input.maxOutputBytes - Buffer.byteLength(output, "utf8");
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (Buffer.byteLength(text, "utf8") <= room) {
        output += text;
        return;
      }
      output += text.slice(0, room);
      truncated = true;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      // The whole group, not just the leader.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, input.timeoutMs);
    timer.unref?.();

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, output, truncated });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => finish(code, signal));

    // The instruction travels on stdin. An executor that does not read it (a script
    // that ignores its input) gets an EPIPE, which is its business and not a reason
    // to fail the run - so the write error is swallowed deliberately.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input.stdin);
  });
}

export function defaultRunDeps(): RunDeps {
  return {
    exec: nodeExec,
    ensureDir: async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
    },
    now: () => Date.now(),
  };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 600);
}
