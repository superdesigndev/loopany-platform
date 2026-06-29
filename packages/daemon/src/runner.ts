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

import { execEnv, runProcess } from "./spawn.js";
import { runWorkflow } from "./workflow.js";
import { sessionTrace, type RunArtifact, type TranscriptStep } from "./artifacts.js";
import { CALLBACK_BIN_DIR } from "./callback-bin.js";
import { setProgress, clearProgress } from "./progress.js";
import { markRunActive, markRunDone } from "./watcher.js";
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
  /** Server-configured workdir jail (preferred over the daemon's env LOOPANY_ROOTS). */
  roots?: string[];
  systemPrompt: string;
  task: string;
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
const TIMEOUT_MS = Number(process.env.LOOPANY_EXEC_TIMEOUT_MS || 15 * 60_000);

interface ClaudeJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
}

export async function runDelivery(d: Delivery, serverUrl: string, roots: string[]): Promise<void> {
  // Attribute artifact syncs that happen during this run to its runId (Phase 3
  // seam) — the loop's folder watcher reads this while the run is in-flight.
  markRunActive(d.loop.id, d.runId);
  try {
    return await runDeliveryImpl(d, serverUrl, roots);
  } finally {
    markRunDone(d.loop.id);
  }
}

async function runDeliveryImpl(d: Delivery, serverUrl: string, roots: string[]): Promise<void> {
  const start = Date.now();
  // Server-configured roots win; the daemon's env LOOPANY_ROOTS is a fallback.
  const effectiveRoots = d.roots ?? roots;
  let workdir: string;
  try {
    workdir = resolveWorkdir(d.loop.workdir, d.loop.id, effectiveRoots);
  } catch (err) {
    return report(serverUrl, d.runToken, { runId: d.runId, ok: false, durationMs: Date.now() - start, error: msg(err) });
  }

  // 1. Workflow gate (cheap, zero-LLM). Pure result → report directly, no claude.
  // Internal evolution passes always run Claude and may update ui/schema/workflow.
  let cursor: unknown;
  let escalation = "";
  if (d.role === "exec" && d.loop.workflow) {
    const wf = await runWorkflow(d.loop.workflow, d.prevState, workdir);
    if (!wf.ok) {
      const tail = wf.stderr.trim().slice(-400);
      return report(serverUrl, d.runToken, {
        runId: d.runId, ok: false, durationMs: Date.now() - start,
        error: tail ? `${wf.error} — ${tail}` : wf.error,
      });
    }
    cursor = wf.result!.state;
    if (wf.result!.agentCalls.length === 0) {
      // Pure workflow: direct message (or silent). No claude — but still sync
      // the task file if the loop maintains one (the workflow may write it).
      return report(serverUrl, d.runToken, {
        runId: d.runId, ok: true, durationMs: Date.now() - start,
        outcome: wf.result!.message ? "direct" : "silent",
        message: wf.result!.message, cursor,
        taskFileContent: readTaskFile(workdir, d.loop.taskFile),
      });
    }
    // Escalation: fold the workflow's signals into claude's task.
    escalation = wf.result!.agentCalls
      .map((c) => [c.message, c.data !== undefined ? "data:\n```json\n" + JSON.stringify(c.data, null, 2) + "\n```" : ""].filter(Boolean).join("\n"))
      .join("\n\n");
  }

  // 2. Exec: run claude (no workflow, or the workflow escalated).
  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  let finalText: string | undefined;
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
    const task = escalation ? `${d.task}\n\nworkflow signal:\n${escalation}` : d.task;
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
    const r = await runProcess(bin, args, { cwd: workdir, env, timeoutMs: TIMEOUT_MS, onStdout: stream.feed });
    clearProgress(d.runId);
    const final = stream.result();
    if (r.timedOut) {
      error = `claude timed out (${Math.round(TIMEOUT_MS / 1000)}s)`;
    } else if (final.json) {
      ok = !final.json.is_error && r.code === 0;
      sessionId = final.sessionId ?? final.json.session_id;
      finalText = final.json.result?.trim() || undefined;
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

  await report(serverUrl, d.runToken, {
    runId: d.runId,
    ok,
    durationMs: Date.now() - start,
    outcome: d.role === "evolve" ? "evolve" : "exec",
    sessionId,
    artifacts,
    transcript,
    taskFileContent: readTaskFile(workdir, d.loop.taskFile),
    error,
    finalText: d.role === "evolve" ? undefined : finalText,
    cursor,
  });
}

/** Best-effort read of the loop's task file for sync to the server. The path may
 *  be absolute, ~-rooted, or relative to the run's workdir. Never throws — a
 *  missing/unreadable file just syncs nothing (the report must still go out). */
function readTaskFile(workdir: string, taskFile: string | null): string | undefined {
  if (!taskFile) return undefined;
  try {
    const expanded = expandTilde(taskFile);
    const file = path.isAbsolute(expanded) ? expanded : path.resolve(workdir, expanded);
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
  if (roots.length) {
    const ok = roots.some((root) => {
      const r = path.resolve(expandTilde(root));
      return abs === r || abs.startsWith(r + path.sep);
    });
    if (!ok) throw new Error(`workdir ${abs} is outside this machine's allowed roots`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
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
 * are skipped so a stray non-JSON line never breaks the run.
 */
function makeStreamConsumer(onProgress: (p: { step: number; label: string }) => void): {
  feed: (chunk: string) => void;
  result: () => StreamFinal;
} {
  let buf = "";
  let step = 0;
  const out: StreamFinal = {};
  const feed = (chunk: string): void => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof ev.session_id === "string" && !out.sessionId) out.sessionId = ev.session_id;
      if (ev.type === "result") {
        out.json = { is_error: ev.is_error, subtype: ev.subtype, result: ev.result, session_id: ev.session_id };
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          const label = labelForBlock(b);
          if (label) onProgress({ step: (step += 1), label });
        }
      }
    }
  };
  return { feed, result: () => out };
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

async function report(serverUrl: string, runToken: string, body: ReportBody): Promise<void> {
  try {
    await fetch(`${serverUrl.replace(/\/$/, "")}/machine/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort; the server's reclaim sweep covers a lost report */
  }
}
