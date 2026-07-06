/**
 * Run one delivery on this machine. First the workflow gate (if the loop has
 * one): a pure workflow that returns a message → report it DIRECTLY, no claude
 * (this is how zero-LLM loops work — e.g. a sensor → digest). Only if the
 * workflow escalates via `agent()` (or the loop has no workflow) do we run
 * claude-code. Finally report the run back to the server.
 */
import fs from "node:fs";
import path from "node:path";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { execEnv, runProcess } from "./spawn.js";
import { runWorkflow, type AgentCall } from "./workflow.js";
import { expandTilde } from "./loopdir.js";
import { effectiveRoots, isWithinRoots } from "./roots.js";
import { sessionTrace, type RunArtifact, type TranscriptStep } from "./artifacts.js";
import { CALLBACK_BIN_DIR } from "./callback-bin.js";
import { setProgress, clearProgress } from "./progress.js";
import { flushLoop, markRunActive, markRunDone } from "./watcher.js";
import { LOOPANY_DIR } from "./config.js";

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
  };
  prevState: unknown;
  /** Server-configured workdir jail — may only NARROW the daemon's local env
   *  LOOPANY_ROOTS jail, never widen it (see roots.effectiveRoots). */
  roots?: string[];
  systemPrompt: string;
  task: string;
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
  /** Files this run's claude session created/edited (parsed from its transcript). */
  artifacts?: RunArtifact[];
  /** Slimmed execution trace (text/tool/result steps) for the run-detail view. */
  transcript?: TranscriptStep[];
  /** Latest content of the loop's task file (the durable context+log doc). */
  taskFileContent?: string;
  error?: string;
  finalText?: string;
}

/** Daemon-side cap on the synced task-file body — it's a growing log doc, so a
 *  huge one is tailed (recent entries are what the detail view is for). */
const TASKFILE_CAP = 256 * 1024;

const SELF_SCHEDULING_TOOLS = "ScheduleWakeup,CronCreate,CronList,CronDelete";
// The coding-agent child runs with NO wall-clock timeout by default — a real run
// can legitimately take a long time, and the server's inactivity-based sweep is the
// guard against a machine that disappears. `LOOPANY_EXEC_TIMEOUT_MS` is an opt-in
// override: a positive number arms the timer; unset/0/invalid/negative ⇒ unlimited
// (runProcess treats a falsy/≤0 timeoutMs as "no timeout").
const rawExecTimeout = Number(process.env.LOOPANY_EXEC_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(rawExecTimeout) && rawExecTimeout > 0 ? rawExecTimeout : 0;
/** Hard cap on the pre-report flush so a slow/hung server can't delay reporting. */
const FLUSH_TIMEOUT_MS = 2500;

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
  // Attribute artifact syncs that happen during this run to its runId (Phase 3
  // seam) — the loop's folder watcher reads this while the run is in-flight.
  markRunActive(d.loop.id, d.runId);
  try {
    return await runDeliveryImpl(d, serverUrl, roots, signal);
  } finally {
    markRunDone(d.loop.id);
  }
}

async function runDeliveryImpl(d: Delivery, serverUrl: string, roots: string[], signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  // Force a final, run-tagged sync of the loop folder right before reporting so
  // the server's run snapshot (Phase 3) captures end-state even if a late write
  // slipped the watcher's debounce. Best-effort and bounded: the flush is raced
  // against a short timeout so a slow/hung server can't stall run reporting (and
  // the notification it triggers) past FLUSH_TIMEOUT_MS — the reclaim sweep + the
  // continuous watcher still converge the server's artifact state afterward.
  const reportRun = async (body: ReportBody): Promise<void> => {
    await Promise.race([
      flushLoop(d.loop.id).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
    return report(serverUrl, d.runToken, body);
  };
  // The LOCAL env jail (LOOPANY_ROOTS) always applies when set; server-sent
  // roots can only narrow it — a hostile server must not widen the jail.
  const jail = effectiveRoots(roots, d.roots);
  let workdir: string;
  try {
    workdir = resolveWorkdir(d.loop.workdir, d.loop.id, jail);
  } catch (err) {
    return reportRun({ runId: d.runId, ok: false, durationMs: Date.now() - start, error: msg(err) });
  }

  // 1. Workflow gate (cheap, zero-LLM). Pure result → report directly, no claude.
  // Internal evolution passes always run Claude and may update ui/schema/workflow.
  let cursor: unknown;
  let escalation = "";
  let workflowFailure: { error: string; source: string } | undefined;
  if (d.role === "exec" && d.loop.workflow) {
    const wf = await runWorkflow(d.loop.workflow, d.prevState, workdir, signal);
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
        // Pure workflow: direct message (or silent). No claude — but still sync
        // the task file if the loop maintains one (the workflow may write it).
        return reportRun({
          runId: d.runId, ok: true, durationMs: Date.now() - start,
          outcome: wf.result!.message ? "direct" : "silent",
          message: wf.result!.message, cursor,
          taskFileContent: readTaskFile(workdir, d.loop.taskFile, roots),
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
  // System prompt goes in ~/.loopany/runs (passed to claude by absolute path), not
  // the workdir — keeps the run's cwd clean. Removed in `finally`.
  const runsDir = path.join(LOOPANY_DIR, "runs");
  const sysFile = path.join(runsDir, `sys-${d.runId}.md`);
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(sysFile, d.systemPrompt, "utf8");

    const env: NodeJS.ProcessEnv = {
      ...execEnv(),
      // Prepend the home bin dir so `loopany` resolves to our re-exec wrapper.
      PATH: `${CALLBACK_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      LOOPANY_RUN_TOKEN: d.runToken,
      LOOPANY_SERVER_URL: serverUrl,
    };
    const task = workflowFailure
      ? buildWorkflowFallbackTask(d.task, workflowFailure, dateStamp(), d.loop.name, d.loop.id)
      : escalation
        ? `${d.task}\n\nworkflow signal:\n${escalation}`
        : d.task;
    // stream-json (JSONL) so we can derive a live progress signal as claude works;
    // the terminal `result` event carries the same fields the single-JSON mode did.
    const args = [
      "-p", task,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--append-system-prompt-file", sysFile,
      "--disallowed-tools", SELF_SCHEDULING_TOOLS,
    ];
    if (d.loop.model) args.push("--model", d.loop.model);

    const stream = makeStreamConsumer((p) => setProgress(d.runId, p));
    const bin = process.env.LOOPANY_CLAUDE_BIN || "claude";
    const r = await runProcess(bin, args, { cwd: workdir, env, timeoutMs: TIMEOUT_MS, onStdout: stream.feed, signal });
    clearProgress(d.runId);
    const final = stream.result();
    if (r.timedOut) {
      error = `claude timed out (${Math.round(TIMEOUT_MS / 1000)}s)`;
      // The stream captured the session id early — keep the pointer so exactly
      // the runs that need debugging (timeouts) still get the transcript/artifact
      // recovery below instead of losing their session.
      sessionId = final.sessionId;
    } else if (final.json) {
      ok = !final.json.is_error && r.code === 0;
      sessionId = final.sessionId ?? final.json.session_id;
      finalText = final.json.result?.trim() || undefined;
      cost = costFromResult(final.json);
      if (!ok) error = final.json.subtype || "claude reported an error";
    } else if (r.code === 0) {
      ok = true;
      sessionId = final.sessionId;
    } else {
      error = (r.stderr || r.stdout || "claude produced no output").trim().slice(0, 500);
    }
  } catch (err) {
    error = `failed to run claude: ${msg(err)}`;
  } finally {
    fs.rmSync(sysFile, { force: true }); // don't let prompt files accumulate
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
    artifacts,
    transcript,
    taskFileContent: readTaskFile(workdir, d.loop.taskFile, roots),
    error,
    finalText: d.role === "evolve" ? undefined : finalText,
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

/** Best-effort read of the loop's task file for sync to the server. The path may
 *  be absolute, ~-rooted, or relative to the run's workdir. Never throws — a
 *  missing/unreadable file just syncs nothing (the report must still go out).
 *  taskFile is SERVER-SENT: under a local LOOPANY_ROOTS jail a path outside both
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

function resolveWorkdir(workdir: string | null, loopId: string, roots: string[]): string {
  if (!workdir) {
    const scratch = path.join(LOOPANY_DIR, "work", loopId);
    fs.mkdirSync(scratch, { recursive: true });
    return scratch;
  }
  const abs = path.resolve(expandTilde(workdir));
  if (roots.length && !isWithinRoots(abs, roots)) {
    throw new Error(`workdir ${abs} is outside this machine's allowed roots`);
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
