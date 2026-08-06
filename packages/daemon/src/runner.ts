/**
 * Run one delivery on this machine. First the workflow gate (if the loop has
 * one): a pure workflow that returns a message → report it DIRECTLY, no claude
 * (this is how zero-LLM loops work — e.g. a sensor → digest). Only if the
 * workflow escalates via `agent()` (or the loop has no workflow) do we run
 * claude-code. Finally report the run back to the server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { execEnv, explainSpawnFailure, runProcess } from "./spawn.js";
import { runWorkflow, type AgentCall } from "./workflow.js";
import { expandTilde } from "./loopdir.js";
import { effectiveRoots, isWithinRoots } from "./roots.js";
import { sessionTrace, type RunArtifact, type TranscriptStep } from "./artifacts.js";
import { CALLBACK_BIN_DIR } from "./callback-bin.js";
import { setProgress, clearProgress } from "./progress.js";
import { LOOPANY_DIR } from "./config.js";
import type { CodingAgent } from "./create.js";

export interface Delivery {
  runId: string;
  runToken: string;
  role: "exec" | "evolve" | "edit";
  loop: {
    id: string;
    name: string;
    workdir: string | null;
    taskFile: string | null;
    workflow: string | null;
    model: string | null;
    allowControl: boolean;
    /** Coding agent to EXECUTE this loop with. Absent on an OLD server (pre-grok)
     *  ⇒ treated as claude-code. The daemon branches spawn + credentials on this
     *  (`claude-code` | `codex` | `grok`). */
    agent?: CodingAgent;
  };
  prevState: unknown;
  /** Absent from old servers; null marks a new-server legacy loop awaiting seed. */
  charter?: null | {
    docId: string;
    key: string;
    docKind: "charter";
    format: "markdown";
    body: string;
    version: number;
  };
  /** Server-configured workdir jail — may only NARROW the daemon's local env
   *  LOOPANY_ROOTS jail, never widen it (see roots.effectiveRoots). */
  roots?: string[];
  /** The loop BOUND a directory, so this machine must already have it: creating
   *  it would execute the charter against an empty lookalike (rewrite v2 path). */
  requireWorkdir?: boolean;
  systemPrompt: string;
  task: string;
  /** Rewrite queue protocol. Absent means the shipping run-token/report path. */
}

/** Claude-reported spend/usage for one run, lifted from the terminal `result`
 *  event (total_cost_usd + usage token counts + num_turns). All optional — an
 *  older claude / a timed-out run may carry none of it. */
export interface RunCost {
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  numTurns?: number;
}

interface ReportBody {
  runId: string;
  ok: boolean;
  durationMs: number;
  outcome?: "direct" | "silent" | "exec" | "evolve";
  message?: string;
  /** Workflow cursor (free-form) to persist as loop.state for next run's `prev`. */
  cursor?: unknown;
  sessionId?: string;
  /** Claude-reported cost/usage for this run (absent for workflow-only runs). */
  cost?: RunCost;
  /** Total claude invocations for this run (present only when > 1 — i.e. the
   *  transient-failure recovery resumed the session at least once). */
  attempts?: number;
  /** Files this run's claude session created/edited (parsed from its transcript). */
  artifacts?: RunArtifact[];
  /** Slimmed execution trace (text/tool/result steps) for the run-detail view. */
  transcript?: TranscriptStep[];
  /** Legacy task-file carry retained during the additive migration window. */
  taskFileContent?: string;
  charterUpdate?: { baseVersion: number | null; content: string };
  resolvedWorkdir?: string;
  error?: string;
  finalText?: string;
}

/** Daemon-side cap for the migration-only legacy task-file carry. */
const TASKFILE_CAP = 256 * 1024;
const CHARTER_CAP = 512 * 1024;
const CHARTER_RUN_DIRS_TO_KEEP = 5;

const SELF_SCHEDULING_TOOLS = "ScheduleWakeup,CronCreate,CronList,CronDelete";

/** The spawn command (executable + argv) for one coding-agent pass. */
export interface AgentSpawn {
  bin: string;
  args: string[];
}

/**
 * Build the coding-agent spawn command (bin + argv) for one run pass.
 *
 * Three arms (BYOA — each agent's real CLI surface):
 *   - `claude-code`: `claude -p … --output-format stream-json --verbose …`
 *   - `grok`: mirrors Claude's shape but uses `streaming-json`, drops `--verbose`
 *     (exit 2) and `--append-system-prompt-file` (no file form).
 *   - `codex`: a DIFFERENT surface — `codex exec` / `codex exec resume`, not `-p`.
 *     Flags verified against codex-cli 0.143.0: `--json` (JSONL on stdout),
 *     `--dangerously-bypass-approvals-and-sandbox` (unattended BYOA, same intent
 *     as claude/grok `bypassPermissions`), optional `-m` / `--model`, and
 *     `--skip-git-repo-check` so non-git loop workdirs are not rejected.
 *
 * Escape hatches: `LOOPANY_CLAUDE_BIN` / `LOOPANY_GROK_BIN` / `LOOPANY_CODEX_BIN`.
 *
 * Telemetry note: grok's headless stream is grok-native (`thought`/`text`/`end`)
 * and codex `--json` is not Claude stream-json either — the Claude-shaped
 * `makeStreamConsumer` parses nothing from either. Both still mark OK on exit 0;
 * the agent's own `loopany report` persists the result. Daemon-side live-
 * progress/cost/transcript for non-Claude agents is degraded until a per-agent
 * stream adapter lands.
 */
export function buildAgentSpawn(opts: {
  agent: CodingAgent;
  prompt: string;
  resumeSessionId?: string;
  model?: string | null;
  /** claude-only: the system-prompt file path (falsy ⇒ flag omitted). */
  sysFile?: string;
}): AgentSpawn {
  const { agent, prompt, resumeSessionId, model, sysFile } = opts;
  if (agent === "codex") {
    // Codex surface is `codex exec [OPTIONS] [PROMPT]` / `codex exec resume
    // [OPTIONS] [SESSION_ID] [PROMPT]` — never Claude's `-p` / stream-json flags.
    const modelArgs = model ? ["-m", model] : [];
    const unattended = [
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      ...modelArgs,
    ];
    if (resumeSessionId) {
      return {
        bin: process.env.LOOPANY_CODEX_BIN || "codex",
        args: ["exec", "resume", resumeSessionId, ...unattended, prompt],
      };
    }
    return {
      bin: process.env.LOOPANY_CODEX_BIN || "codex",
      args: ["exec", ...unattended, prompt],
    };
  }
  const resume = resumeSessionId ? ["--resume", resumeSessionId] : [];
  const modelArgs = model ? ["--model", model] : [];
  if (agent === "grok") {
    return {
      bin: process.env.LOOPANY_GROK_BIN || "grok",
      args: [
        "-p", prompt,
        ...resume,
        "--output-format", "streaming-json",
        "--permission-mode", "bypassPermissions",
        "--disallowed-tools", SELF_SCHEDULING_TOOLS,
        ...modelArgs,
      ],
    };
  }
  return {
    bin: process.env.LOOPANY_CLAUDE_BIN || "claude",
    args: [
      "-p", prompt,
      ...resume,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      ...(sysFile ? ["--append-system-prompt-file", sysFile] : []),
      "--disallowed-tools", SELF_SCHEDULING_TOOLS,
      ...modelArgs,
    ],
  };
}

// The coding-agent child runs with NO wall-clock timeout by default — a real run
// can legitimately take a long time, and the server's inactivity-based sweep is the
// guard against a machine that disappears. `LOOPANY_EXEC_TIMEOUT_MS` is an opt-in
// override: a positive number arms the timer; unset/0/invalid/negative ⇒ unlimited
// (runProcess treats a falsy/≤0 timeoutMs as "no timeout").
const rawExecTimeout = Number(process.env.LOOPANY_EXEC_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(rawExecTimeout) && rawExecTimeout > 0 ? rawExecTimeout : 0;

// Transient-failure recovery: when claude dies mid-run on an infrastructure
// error (an API "Connection closed mid-response", ECONNRESET, overloaded/5xx,
// a rate limit), the session on disk still holds all paid-for progress — so we
// RESUME it (`claude --resume <sessionId>`) with a short continuation prompt
// instead of failing the run or restarting from zero. Bounded + classified:
// only `transient` failures retry (auth/quota must not spin — BYOA decision 8 —
// and a poisoned request would deterministically re-fail on resume); backoff
// between attempts (base, then 4x) keeps a wobbly provider from being hammered.
const rawRetries = Number(process.env.LOOPANY_TRANSIENT_RETRIES);
const TRANSIENT_RETRIES = Number.isFinite(rawRetries) && rawRetries >= 0 ? Math.floor(rawRetries) : 2;
const rawRetryBase = Number(process.env.LOOPANY_TRANSIENT_RETRY_BASE_MS);
const RETRY_BASE_MS = Number.isFinite(rawRetryBase) && rawRetryBase > 0 ? rawRetryBase : 15_000;

export type FailureClass = "transient" | "poisoned" | "auth" | "task";

/**
 * Classify a failed claude run from its combined error text (error + final text
 * + stderr). Precedence matters: auth/quota outranks everything (a 401 body may
 * also say "API Error" — retrying spins), poisoned outranks transient (a
 * too-long prompt resumes into the same 400). Anything unrecognized is a plain
 * `task` failure — never retried. Pure + exported for tests.
 */
export function classifyFailure(text: string): FailureClass {
  if (
    /\b(401|403)\b/.test(text) ||
    /unauthoriz|forbidden|authentication_error|invalid api key|oauth/i.test(text) ||
    /usage limit|quota exceeded|credit balance|out of credits|billing/i.test(text)
  ) {
    return "auth";
  }
  if (/invalid_request_error|prompt is too long|context (window|length)|request too large|\b400\b/i.test(text)) {
    return "poisoned";
  }
  if (
    /api error/i.test(text) ||
    /connection (closed|reset|error|refused)/i.test(text) ||
    /econnreset|etimedout|econnrefused|enotfound|eai_again|epipe/i.test(text) ||
    /socket hang ?up|fetch failed|network error|request timed out/i.test(text) ||
    /stream (closed|error|ended|disconnected)/i.test(text) ||
    /overloaded|rate.?limit|too many requests/i.test(text) ||
    /\b(429|500|502|503|504|529)\b/.test(text)
  ) {
    return "transient";
  }
  return "task";
}

/** The continuation prompt for a resumed session: the prior progress is already
 *  in the conversation, so the only jobs are "trust it" and "finish per the
 *  original instructions" (exactly one report/finish). Pure + exported for tests. */
export function buildResumeTask(reason: string): string {
  return [
    `Your previous attempt at this run was interrupted by a transient infrastructure error (${reason}).`,
    "You have been RESUMED in the same session: everything above this message is your own prior progress — trust it, do not redo completed work.",
    "Continue from where you left off and finish normally: end with exactly ONE `loopany report ...` (or `loopany finish` when the goal is genuinely met), exactly as the original instructions specify.",
  ].join("\n");
}

/** Sum two attempts' cost/usage (a resumed run pays for each invocation). */
export function addCost(a: RunCost | undefined, b: RunCost | undefined): RunCost | undefined {
  if (!a) return b;
  if (!b) return a;
  const keys: (keyof RunCost)[] = ["usd", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "numTurns"];
  const out: RunCost = {};
  for (const k of keys) {
    const sum = (a[k] ?? 0) + (b[k] ?? 0);
    if (a[k] !== undefined || b[k] !== undefined) out[k] = sum;
  }
  return out;
}

/** Backoff before resume attempt N (1-based): base, then 4x, ±10% jitter. */
function retryDelayMs(attempt: number): number {
  const base = RETRY_BASE_MS * 4 ** (attempt - 1);
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

/** Abortable sleep — a daemon shutdown must not hold the delivery hostage. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

interface ClaudeJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** A finite non-negative number, else undefined (untrusted parse of claude's JSON). */
function nonNeg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Distill the terminal `result` event's cost/usage fields into a RunCost, or
 *  undefined when the event carried none of them. Exported for tests. */
export function costFromResult(j: ClaudeJson): RunCost | undefined {
  const u = j.usage ?? {};
  const cost: RunCost = {
    usd: nonNeg(j.total_cost_usd),
    inputTokens: nonNeg(u.input_tokens),
    outputTokens: nonNeg(u.output_tokens),
    cacheReadTokens: nonNeg(u.cache_read_input_tokens),
    cacheCreationTokens: nonNeg(u.cache_creation_input_tokens),
    numTurns: nonNeg(j.num_turns),
  };
  return Object.values(cost).some((v) => v !== undefined) ? cost : undefined;
}

export async function runDelivery(d: Delivery, serverUrl: string, roots: string[], signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  // The LOCAL env jail (LOOPANY_ROOTS) always applies when set; server-sent
  // roots can only narrow it — a hostile server must not widen the jail.
  const jail = effectiveRoots(roots, d.roots);
  const charterProtocol = Object.prototype.hasOwnProperty.call(d, "charter");
  let workdir: string | undefined;
  let resolvedWorkdir: string | undefined;
  let charterFile: string | undefined;
  let deliveredCharter = "";
  let charterBaseVersion: number | null = null;
  let seedCharter = false;

  // Every terminal path uses this one report wrapper. It carries edits from the
  // per-run daemon-home file on clean, failed and interrupted runs alike.
  const reportRun = async (body: ReportBody): Promise<void> => {
    const outgoing: ReportBody = { ...body };
    if (charterProtocol) {
      if (resolvedWorkdir) outgoing.resolvedWorkdir = resolvedWorkdir;
      if (charterFile) {
        try {
          const content = fs.readFileSync(charterFile, "utf8");
          const bytes = Buffer.byteLength(content, "utf8");
          if (bytes > CHARTER_CAP) {
            logger.warn({ runId: d.runId, bytes }, "charter carry omitted: complete file exceeds size limit");
          } else if (seedCharter || content !== deliveredCharter) {
            outgoing.charterUpdate = { baseVersion: charterBaseVersion, content };
          }
        } catch (cause) {
          logger.warn({ runId: d.runId, error: msg(cause) }, "charter carry omitted: per-run file could not be read");
        }
      }
    } else if (workdir) {
      // Old-server compatibility: preserve the pre-charter task-file report.
      outgoing.taskFileContent = readTaskFile(workdir, d.loop.taskFile, roots);
    }
    await report(serverUrl, d.runToken, outgoing);
    if (charterFile) pruneCharterRunDirs(d.loop.id, d.runId);
  };

  try {
    if (charterProtocol && d.charter === null && !d.loop.workdir && d.loop.taskFile) {
      const legacyFile = resolveLegacyTaskFile(d.loop.taskFile, jail);
      workdir = path.dirname(legacyFile);
      resolvedWorkdir = workdir;
    } else {
      workdir = resolveWorkdir(
        d.loop.workdir,
        d.loop.id,
        jail,
        d.requireWorkdir === true || (charterProtocol && d.loop.workdir !== null),
      );
    }

    if (charterProtocol) {
      if (d.charter) {
        deliveredCharter = d.charter.body;
        charterBaseVersion = d.charter.version;
      } else if (d.loop.taskFile) {
        const legacyFile = resolveLegacyTaskFile(d.loop.taskFile, jail, workdir);
        deliveredCharter = readCompleteCharter(legacyFile);
        seedCharter = true;
      } else if (d.loop.workflow) {
        deliveredCharter = "";
        seedCharter = true;
      } else {
        throw new Error("this loop has no attached charter or readable legacy task file; no agent was launched");
      }
      charterFile = materializeCharter(d.loop.id, d.runId, deliveredCharter);
    }
  } catch (err) {
    return reportRun({ runId: d.runId, ok: false, durationMs: Date.now() - start, error: msg(err) });
  }

  // 1. Workflow gate (cheap, zero-LLM). Pure result → report directly, no agent.
  // Internal evolution passes skip this gate (they run the loop's coding agent
  // directly) and may update ui/schema/workflow.
  let cursor: unknown;
  let escalation = "";
  let workflowFailure: { error: string; source: string } | undefined;
  if (d.role === "exec" && d.loop.workflow) {
    const wf = await runWorkflow(
      d.loop.workflow,
      d.prevState,
      workdir,
      signal,
      charterFile ? { LOOPANY_CHARTER_FILE: charterFile } : {},
    );
    if (!wf.ok) {
      // A failed workflow (thrown JS, a failed tools.call, a timeout) no longer just
      // reports a failed run. Instead we FALL BACK to the agent: it first completes
      // this run's original task (the loop still delivers this tick), then diagnoses
      // the workflow failure. Don't advance the cursor — the workflow produced none.
      const tail = wf.stderr.trim().slice(-1200);
      const err = wf.error ?? "workflow failed";
      workflowFailure = {
        error: tail ? `${err}\n${tail}` : err,
        source: d.loop.workflow,
      };
      // fall through to the claude section below (task is augmented for the fallback).
    } else {
      cursor = wf.result!.state;
      if (wf.result!.agentCalls.length === 0) {
        // Pure workflow: direct message (or silent). Still diff-carry the
        // materialized charter because the workflow may have edited it.
        return reportRun({
          runId: d.runId, ok: true, durationMs: Date.now() - start,
          outcome: wf.result!.message ? "direct" : "silent",
          message: wf.result!.message, cursor,
        });
      }
      // Escalation: fold the workflow's signals into claude's task.
      escalation = foldEscalation(wf.result!.agentCalls);
    }
  }

  // 2. Exec: run claude (no workflow, the workflow escalated, or it FAILED → fallback).
  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  let finalText: string | undefined;
  let cost: RunCost | undefined;
  let attempts = 0;
  // System prompt goes in ~/.loopany/runs (passed to claude by absolute path), not
  // the workdir — keeps the run's cwd clean. Removed in `finally`. Batches 1-2 move
  // the full run instructions into the first user turn, so `systemPrompt` is now empty
  // on a current server: skip the sys file + the claude-only `--append-system-prompt-file`
  // flag entirely (an OLD server still populates it and keeps working — the flag path
  // is preserved when the string is non-empty).
  const runsDir = path.join(LOOPANY_DIR, "runs");
  const hasSystemPrompt = d.systemPrompt.trim().length > 0;
  const sysFile = hasSystemPrompt ? path.join(runsDir, `sys-${d.runId}.md`) : "";
  // Which coding agent executes this loop. Absent on an OLD server (pre-grok) ⇒
  // claude-code. Spawn + credential set branch on the agent; agentLabel names the
  // binary family in failure reasons (claude / codex / grok).
  const agent: CodingAgent = d.loop.agent ?? "claude-code";
  const agentLabel = agent === "claude-code" ? "claude" : agent;
  try {
    if (hasSystemPrompt) {
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(sysFile, d.systemPrompt, "utf8");
    }

    const env: NodeJS.ProcessEnv = {
      ...execEnv(agent),
      // Prepend the home bin dir so `loopany` resolves to our re-exec wrapper.
      PATH: `${CALLBACK_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      LOOPANY_SERVER_URL: serverUrl,
      // `LOOPANY_RUN_ID` is the INVISIBLE run context the kernel verbs
      // authenticate with (`kernel/apiAuth.ts`); `LOOPANY_RUN_TOKEN` is the run
      // lease the shipping callback carries. Both, always.
      LOOPANY_RUN_ID: d.runId,
      LOOPANY_RUN_TOKEN: d.runToken,
      ...(charterFile ? { LOOPANY_CHARTER_FILE: charterFile } : {}),
    };
    const task = workflowFailure
      ? buildWorkflowFallbackTask(d.task, workflowFailure, dateStamp(), d.loop.name, d.loop.id)
      : escalation
        ? `${d.task}\n\nworkflow signal:\n${escalation}`
        : d.task;

    // Attempt loop: the first pass runs the task; each further pass RESUMES the
    // same session after a transient infrastructure failure (see the constants
    // block above). Timeouts never retry (our own wall-clock guard, not a
    // provider blip), a failure with no captured session has nothing to resume,
    // and an abort (daemon shutdown / cancel) stops immediately.
    for (;;) {
      attempts += 1;
      const resuming = attempts > 1;
      const prompt = resuming ? buildResumeTask(error ?? "transient API error") : task;
      // Claude stream-json (JSONL) yields live progress + a terminal `result` event.
      // Grok/codex emit non-Claude streams we can't yet parse — see buildAgentSpawn.
      const { bin, args } = buildAgentSpawn({
        agent,
        prompt,
        resumeSessionId: resuming ? sessionId : undefined,
        model: d.loop.model,
        sysFile: hasSystemPrompt ? sysFile : undefined,
      });

      const stream = makeStreamConsumer((p) => setProgress(d.runId, p));
      const r = await runProcess(bin, args, { cwd: workdir, env, timeoutMs: TIMEOUT_MS, onStdout: stream.feed, signal });
      clearProgress(d.runId);
      const final = stream.result();
      error = undefined;
      finalText = undefined;
      if (r.timedOut) {
        error = `${agentLabel} timed out (${Math.round(TIMEOUT_MS / 1000)}s)`;
        // The stream captured the session id early — keep the pointer so exactly
        // the runs that need debugging (timeouts) still get the transcript/artifact
        // recovery below instead of losing their session.
        sessionId = final.sessionId ?? sessionId;
        break;
      } else if (final.json) {
        ok = !final.json.is_error && r.code === 0;
        // `--resume` forks a NEW session id — track the latest so a further
        // resume (and the transcript/artifact recovery below) follow the fork.
        sessionId = final.sessionId ?? final.json.session_id ?? sessionId;
        finalText = final.json.result?.trim() || undefined;
        cost = addCost(cost, costFromResult(final.json));
        if (!ok) {
          // A non-zero exit can arrive WITH a clean result event (subtype "success") —
          // recording "success" as the error reads as nonsense; name the exit instead.
          const subtype = final.json.subtype;
          error =
            subtype && subtype !== "success"
              ? subtype
              : r.code !== 0
                ? `${agentLabel} exited with code ${r.code}`
                : `${agentLabel} reported an error`;
        }
      } else if (r.code === 0) {
        ok = true;
        sessionId = final.sessionId ?? sessionId;
      } else {
        error = (r.stderr || r.stdout || `${agentLabel} produced no output`).trim().slice(0, 500);
        sessionId = final.sessionId ?? sessionId;
      }

      if (ok || attempts > TRANSIENT_RETRIES || !sessionId || signal?.aborted) break;
      const failureClass = classifyFailure([error, finalText, r.stderr].filter(Boolean).join("\n"));
      if (failureClass !== "transient") break;
      const wait = retryDelayMs(attempts);
      logger.warn(
        { runId: d.runId, attempt: attempts, waitMs: wait, error },
        "transient claude failure — resuming the session after backoff",
      );
      // Keep the live signal honest during the wait (and the server's inactivity
      // sweep fed — the progress stamp rides the poll heartbeat).
      setProgress(d.runId, { step: attempts, label: `retrying after a transient API error (attempt ${attempts + 1})` });
      await sleep(wait, signal);
      clearProgress(d.runId);
      if (signal?.aborted) break;
    }
  } catch (err) {
    // A raw `spawn EBADF`/`EMFILE` names no resource; explainSpawnFailure adds the
    // fd count and the ceiling, so the cause is readable straight off the run.
    error = explainSpawnFailure(err, `failed to run ${agentLabel}: ${msg(err)}`);
  } finally {
    if (sysFile) fs.rmSync(sysFile, { force: true }); // don't let prompt files accumulate
  }

  // Recover this session's artifacts + slimmed trace from ONE transcript read (best-effort).
  let artifacts: RunArtifact[] | undefined;
  let transcript: TranscriptStep[] | undefined;
  if (sessionId) {
    try {
      const trace = sessionTrace(sessionId, workdir);
      if (trace.artifacts.length) artifacts = trace.artifacts;
      if (trace.transcript.length) transcript = trace.transcript;
    } catch {
      /* never let transcript parsing break the report — it's a nicety */
    }
  }

  await reportRun({
    runId: d.runId,
    ok,
    durationMs: Date.now() - start,
    outcome: d.role === "evolve" ? "evolve" : "exec",
    sessionId,
    cost,
    ...(attempts > 1 ? { attempts } : {}),
    artifacts,
    transcript,
    error,
    // Every role sends finalText: the server only uses it as a message FALLBACK
    // when the run didn't `loopany report --message` itself, and evolve/edit are
    // notification-exempt server-side — so an evolve pass that forgets to report
    // still leaves a readable run-log line instead of a blank timeline block.
    finalText,
    cursor,
  });
}

/** UTC date stamp (YYYY-MM-DD) for the dated workflow-setup file name. */
export function dateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the fallback task handed to claude when a loop's deterministic workflow FAILS.
 * The agent must (1) still complete this run's original task so the loop delivers this
 * tick, then (2) diagnose the workflow failure. If the fix needs the USER to change
 * permissions / env / MCP auth, the agent writes a dated `workflow-setup-<date>.md` in
 * the loop's workdir and surfaces a one-line copy-paste fix prompt in its report.
 *
 * Pure + exported so it's unit-testable: the fallback task must carry the original task,
 * the workflow error, and the workflow source.
 */
export function buildWorkflowFallbackTask(
  originalTask: string,
  failure: { error: string; source: string },
  dateStr: string,
  loopName: string,
  loopId = "",
): string {
  const slug = loopName || "this-loop";
  const setupFile = `workflow-setup-${dateStr}.md`;
  // A SyntaxError is a DETERMINISTIC parse failure: the workflow never runs, fails
  // identically every tick, and an exec run has NO verb to fix it (set-workflow is
  // evolve/edit-only). So it must escalate to the owner, not quietly wait for evolve.
  const isSyntaxError = /SyntaxError/.test(failure.error);
  const editCmd = loopId
    ? `loopany edit ${loopId} --workflow-file <corrected.js>`
    : `loopany edit <loop-id> --workflow-file <corrected.js>`;
  const closing = isSyntaxError
    ? [
        "This is a SYNTAX ERROR: the workflow fails to parse, so it never runs and will",
        "fail IDENTICALLY on every future tick until the workflow is rewritten or cleared.",
        "You (an exec run) have NO command to change the workflow — `set-workflow` is an",
        "evolve/edit-only verb — so do NOT try to fix it yourself and do NOT just note it",
        "for the next evolve pass (the loop would keep failing every tick until then).",
        "Treat it as a user-fix case: write the setup file above with the concrete syntax",
        "problem and a corrected workflow body (remember: a workflow is a plain script body",
        "run inside an async function — NOT an ES module, NOT the Claude Code Workflow tool;",
        "no top-level `export`/`import`, e.g. no `export const meta = {…}`). Then surface ONE",
        "copy-paste owner prompt to apply it from their machine, e.g.:",
        "",
        `    ${editCmd}`,
        "",
        "or, if the workflow isn't worth keeping, clear it (`loopany edit <loop-id> --json",
        `'{"workflow":""}'`,
        ").",
      ]
    : [
        "If instead the workflow just has a plain bug you could fix deterministically (a wrong",
        "tool name, a bad filter), note it briefly for the next evolve pass — don't bother the",
        "user with a fix that doesn't need them.",
      ];
  return [
    originalTask,
    "",
    "---",
    "IMPORTANT — workflow fallback. This loop has a cheap deterministic pre-stage (its",
    "workflow) that runs before you. This tick the workflow FAILED, so it fell back to you.",
    "Do TWO things, in order:",
    "",
    "1. First, complete THIS run's original task above, exactly as you normally would, so",
    "   the loop still delivers its result this tick. Do not let the workflow failure stop",
    "   you from doing the real work.",
    "",
    "2. Then diagnose why the workflow failed, using the error and source below.",
    "",
    "Workflow error:",
    "```",
    failure.error,
    "```",
    "",
    "Workflow source:",
    "```js",
    failure.source,
    "```",
    "",
    `If fixing the workflow needs the USER to change something you cannot (authorize an MCP`,
    `server, set an env var / credential, grant a permission, install a runtime), do NOT try`,
    `to do it yourself. Instead write a dated setup file \`${setupFile}\` in this loop's`,
    `working directory that explains, concretely, exactly what the user must do to fix it.`,
    `Then, in your report to the user, include ONE short copy-paste prompt they can paste`,
    `into Claude Code or Codex to resolve it, e.g.:`,
    "",
    `    fix workflow issue in loopany/${slug}/${setupFile}`,
    "",
    "Note: the workflow subprocess runs with an ALLOWLISTED env — it does not inherit the",
    "user's shell. If the failure is a missing credential that the MCP server config reads",
    "from the environment (a `${VAR}` / `$env:VAR` placeholder, or a stdio server's env),",
    "the fix is to name that key in `LOOPANY_WORKFLOW_ENV` (comma-separated env key names",
    "passed through to the workflow) in the daemon's environment and restart the daemon —",
    "say so concretely in the setup file.",
    "",
    ...closing,
  ].join("\n");
}

/** Per-call cap on the JSON-folded `agent()` data. The whole task travels to
 *  claude via `-p` argv, and the OS argv limit (E2BIG, ≈256KB on macOS) would
 *  kill the run outright — so a runaway tools.call result is clipped instead. */
const ESCALATION_JSON_CAP = 64 * 1024;

/** Fold the workflow's agent() escalation calls into claude's task text.
 *  Pure + exported for tests: each call's data JSON is capped (see above) with
 *  an explicit truncation marker so the agent knows the payload was clipped. */
export function foldEscalation(calls: AgentCall[]): string {
  return calls
    .map((c) => {
      let dataBlock = "";
      if (c.data !== undefined) {
        let json = JSON.stringify(c.data, null, 2);
        if (json.length > ESCALATION_JSON_CAP) {
          json = json.slice(0, ESCALATION_JSON_CAP) + `\n… [truncated — agent() data exceeded ${Math.round(ESCALATION_JSON_CAP / 1024)}KB; the task travels via argv]`;
        }
        dataBlock = "data:\n```json\n" + json + "\n```";
      }
      return [c.message, dataBlock].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/** Best-effort read for the pre-charter report protocol only. The path may be absolute,
 *  ~-rooted, or relative to the run's workdir. Never throws — a missing/unreadable
 *  file just carries nothing (the report must still go out).
 *  taskFile is legacy SERVER-SENT data: under a local LOOPANY_ROOTS jail a path outside both
 *  the (already-jailed) workdir and the local roots is never read. */
function readTaskFile(workdir: string, taskFile: string | null, localRoots: string[]): string | undefined {
  if (!taskFile) return undefined;
  try {
    const expanded = expandTilde(taskFile);
    // resolve() handles both cases (an absolute path is normalized, a relative
    // one is anchored to the workdir) — unresolved `..` segments must never
    // survive into the lexical jail check below. The (already-jailed, absolute)
    // workdir joins the allowed roots so an in-workdir task file always reads.
    const file = path.resolve(workdir, expanded);
    if (localRoots.length && !isWithinRoots(file, [workdir, ...localRoots])) return undefined;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length <= TASKFILE_CAP) return raw;
    return `… (truncated — last ${Math.round(TASKFILE_CAP / 1024)}KB of ${Math.round(raw.length / 1024)}KB)\n\n` + raw.slice(-TASKFILE_CAP);
  } catch {
    return undefined;
  }
}

/** Resolve the migration-only legacy source without mutating it. */
function resolveLegacyTaskFile(taskFile: string, roots: string[], workdir?: string): string {
  const expanded = expandTilde(taskFile);
  const file = path.resolve(workdir ?? process.cwd(), expanded);
  if (roots.length && !isWithinRoots(file, [...roots, ...(workdir ? [workdir] : [])])) {
    throw new Error(`legacy task file ${file} is outside this machine's allowed roots`);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`legacy task file ${file} does not exist on this machine`);
  }
  return file;
}

function readCompleteCharter(file: string): string {
  const body = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > CHARTER_CAP) {
    throw new Error(`legacy charter ${file} is ${bytes} bytes; complete-body limit is ${CHARTER_CAP}`);
  }
  return body;
}

function safeRunSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not safe for daemon-home materialization`);
  }
  return value;
}

/** Atomic per-run materialization under daemon home, never under the project cwd. */
export function materializeCharter(loopId: string, runId: string, body: string): string {
  const loopPart = safeRunSegment(loopId, "loop id");
  const runPart = safeRunSegment(runId, "run id");
  const daemonHome = process.env.LOOPANY_HOME || LOOPANY_DIR;
  const dir = path.join(daemonHome, "work", loopPart, `run-${runPart}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "README.md");
  const temp = path.join(dir, `.README.md.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, body, "utf8");
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

/** Best-effort bounded retention for daemon-owned per-run charter directories. */
export function pruneCharterRunDirs(loopId: string, currentRunId: string): void {
  try {
    const daemonHome = process.env.LOOPANY_HOME || LOOPANY_DIR;
    const parent = path.join(daemonHome, "work", safeRunSegment(loopId, "loop id"));
    const current = `run-${safeRunSegment(currentRunId, "run id")}`;
    const dirs = fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-") && /^[A-Za-z0-9._-]+$/.test(entry.name))
      .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(parent, entry.name)).mtimeMs }))
      .sort((a, b) => (a.name === current ? -1 : b.name === current ? 1 : b.mtime - a.mtime));
    for (const stale of dirs.slice(CHARTER_RUN_DIRS_TO_KEEP)) {
      fs.rmSync(path.join(parent, stale.name), { recursive: true, force: true });
    }
  } catch {
    /* retention must never break a report */
  }
}

/**
 * Where this run executes.
 *
 * No workdir at all ⇒ the daemon's own per-loop scratch dir, created on demand
 * (its location is local and fixed, so creating it invents nothing).
 *
 * A DECLARED workdir is a BINDING to a place on a machine. On the legacy path the
 * daemon still creates it (the loop was bound to one machine at birth, so the
 * path was authored against this filesystem). On the rewrite path ANY machine of
 * the team may claim the run, so `requireExisting` is set: a missing directory is
 * a loud failure rather than a freshly-mkdir'd empty lookalike of the repo the
 * charter names — silent misplacement is the one outcome worth refusing.
 */
function resolveWorkdir(workdir: string | null, loopId: string, roots: string[], requireExisting = false): string {
  if (!workdir) {
    const scratch = path.join(LOOPANY_DIR, "work", loopId);
    fs.mkdirSync(scratch, { recursive: true });
    return scratch;
  }
  const abs = path.resolve(expandTilde(workdir));
  if (roots.length && !isWithinRoots(abs, roots)) {
    throw new Error(`workdir ${abs} is outside this machine's allowed roots`);
  }
  if (requireExisting) {
    if (!fs.existsSync(abs)) {
      throw new Error(`this loop is bound to ${abs}, which does not exist on this machine (${os.hostname()}) — bind the loop to a machine that has it, or create the directory there. Nothing was created and no agent was launched.`);
    }
    if (!fs.statSync(abs).isDirectory()) {
      throw new Error(`this loop is bound to ${abs}, which is not a directory on this machine (${os.hostname()})`);
    }
    return abs;
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

interface StreamFinal {
  sessionId?: string;
  /** The terminal `result` event, normalized to the old single-JSON shape. */
  json?: ClaudeJson;
}

/**
 * Parse claude's stream-json (JSONL) incrementally: derive a slim progress signal
 * from assistant tool_use/text blocks (pushed via onProgress), and capture the
 * session id (available early) + the terminal `result` event. Unparseable lines
 * are skipped so a stray non-JSON line never breaks the run. Exported for tests.
 */
export function makeStreamConsumer(onProgress: (p: { step: number; label: string }) => void): {
  feed: (chunk: string) => void;
  result: () => StreamFinal;
} {
  let buf = "";
  let step = 0;
  const out: StreamFinal = {};
  const handleLine = (line: string): void => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof ev.session_id === "string" && !out.sessionId) out.sessionId = ev.session_id;
    if (ev.type === "result") {
      out.json = {
        is_error: ev.is_error,
        subtype: ev.subtype,
        result: ev.result,
        session_id: ev.session_id,
        total_cost_usd: ev.total_cost_usd,
        num_turns: ev.num_turns,
        usage: ev.usage,
      };
    } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        const label = labelForBlock(b);
        if (label) onProgress({ step: (step += 1), label });
      }
    }
  };
  const feed = (chunk: string): void => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  };
  const result = (): StreamFinal => {
    // Flush a final UNTERMINATED line — the terminal `result` event may arrive
    // without a trailing newline, and dropping it would lose ok/sessionId.
    const rest = buf.trim();
    buf = "";
    if (rest) handleLine(rest);
    return out;
  };
  return { feed, result };
}

/** A short human "what's it doing now" line distilled from one content block. */
function labelForBlock(b: any): string | undefined {
  if (b?.type === "tool_use" && typeof b.name === "string") {
    const i = b.input ?? {};
    const target = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description;
    const tail = typeof target === "string" && target.trim() ? `: ${oneLine(target)}` : "";
    return clip(`${b.name}${tail}`);
  }
  if (b?.type === "text" && typeof b.text === "string") {
    const line = oneLine(b.text);
    return line ? clip(line) : undefined;
  }
  return undefined;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Generous per-attempt timeout on the report POST — a hung connection must not
 *  stall the delivery (the run would look lost). */
const REPORT_TIMEOUT_MS = 60_000;

async function report(serverUrl: string, runToken: string, body: ReportBody): Promise<void> {
  // One retry on a thrown fetch (timeout / transient network) — still
  // best-effort: the server's reclaim sweep covers a genuinely lost report.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await boundedFetch(`${serverUrl.replace(/\/$/, "")}/machine/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, REPORT_TIMEOUT_MS);
      // A 401 here means the run token was already revoked server-side — almost
      // always because the run was reclaimed while this machine was asleep/offline
      // and only now delivered its result. Don't retry (the token stays 401) and
      // don't fail silently: name it so on-machine debugging isn't a mystery. The
      // server honors one such late report to reconcile the run when it can.
      if (res.status === 401) {
        logger.warn(
          { runId: body.runId, status: res.status },
          "report: run was already reclaimed by the server (machine was likely asleep); result delivered late",
        );
        return;
      }
      if (!res.ok) {
        logger.warn({ runId: body.runId, status: res.status, statusText: res.statusText }, "report: non-ok response");
      }
      return;
    } catch {
      /* retry once, then give up */
    }
  }
}
