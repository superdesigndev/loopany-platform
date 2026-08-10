/**
 * ACP transport for coding agents.
 *
 * Loopany still owns scheduling, run leases, callbacks, and reporting. acpx owns
 * the ACP client lifecycle, while the bundled Codex ACP adapter translates the
 * Codex App Server stream into protocol-level JSON-RPC events. This module keeps
 * that alpha CLI surface behind one small adapter so the native CLI path remains
 * the default and a future in-process ACP client is a local replacement.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RunArtifact, TranscriptStep } from "./artifacts.js";
import type { AgentSpawn, RunCost } from "./runner.js";

export type CodexBackend = "native" | "acp";

export interface AcpStreamFinal {
  sessionId?: string;
  stopReason?: string;
  finalText?: string;
  error?: string;
  cost?: RunCost;
  artifacts: RunArtifact[];
  transcript: TranscriptStep[];
}

const STEP_TEXT_MAX = 1500;
const MAX_STEPS = 80;
const FINAL_TEXT_MAX = 64 * 1024;

/** Opt-in only until the ACP path has soaked on real loops. */
export function resolveCodexBackend(raw = process.env.LOOPANY_CODEX_BACKEND): CodexBackend {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "native" || value === "cli") return "native";
  if (value === "acp") return "acp";
  throw new Error(`LOOPANY_CODEX_BACKEND must be native or acp (got ${JSON.stringify(raw)})`);
}

/** Stable, acpx-safe name: one persistent ACP session per Loopany run. */
export function acpSessionName(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96) || "run";
  return `loopany-${safe}`;
}

function quotedCommandPart(value: string): string {
  // acpx parses the raw --agent value itself; JSON string quoting gives it one
  // argv word even when an npm/global install path contains spaces.
  return JSON.stringify(value);
}

/**
 * Run the bundled/pinned ACP client and Codex adapter without relying on PATH or
 * npx. Escape hatches accept an executable for acpx and a raw ACP agent command.
 */
function codexAcpInvocation(opts: {
  sessionName: string;
  model?: string | null;
}, commandArgs: string[]): AgentSpawn {
  const acpxBin = process.env.LOOPANY_ACPX_BIN;
  const acpxCli = fileURLToPath(import.meta.resolve("acpx"));
  const adapterCli = fileURLToPath(import.meta.resolve("@agentclientprotocol/codex-acp"));
  const agentCommand =
    process.env.LOOPANY_CODEX_ACP_BIN ||
    `${quotedCommandPart(process.execPath)} ${quotedCommandPart(adapterCli)}`;
  const prefix = acpxBin ? [] : [acpxCli];
  return {
    bin: acpxBin || process.execPath,
    args: [
      ...prefix,
      "--agent", agentCommand,
      "--approve-all",
      "--non-interactive-permissions", "fail",
      // The bundled adapter can use the Codex App Server's existing ChatGPT
      // login even when it advertises only an ACP api-key method headlessly.
      // `fail` incorrectly rejects that valid local-login path; skip means
      // "do not initiate a separate ACP authenticate exchange".
      "--auth-policy", "skip",
      "--format", "json",
      "--json-strict",
      "--suppress-reads",
      // The queue owner may linger just long enough to flush state; a later
      // retry reconnects through the named session and ACP session/load.
      "--ttl", "1",
      ...(opts.model ? ["--model", opts.model] : []),
      ...commandArgs,
    ],
  };
}

export function buildCodexAcpSpawn(opts: {
  prompt: string;
  sessionName: string;
  model?: string | null;
}): AgentSpawn {
  return codexAcpInvocation(opts, ["prompt", "--session", opts.sessionName, opts.prompt]);
}

/** acpx does not implicitly create a named session: ensure it before prompt. */
export function buildCodexAcpEnsureSpawn(opts: {
  sessionName: string;
  model?: string | null;
}): AgentSpawn {
  return codexAcpInvocation(opts, ["sessions", "ensure", "--name", opts.sessionName]);
}

function nonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstNonNeg(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = nonNeg(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Detailed end-turn usage from ACP's session/prompt response. */
export function costFromAcpResult(result: any): RunCost | undefined {
  const usage = result?.usage && typeof result.usage === "object" ? result.usage : {};
  const quota = result?._meta?.quota?.token_count ?? {};
  const cost: RunCost = {
    totalTokens: firstNonNeg(usage.totalTokens, quota.totalTokens),
    inputTokens: firstNonNeg(usage.inputTokens, quota.inputTokens),
    outputTokens: firstNonNeg(usage.outputTokens, quota.outputTokens),
    cacheReadTokens: firstNonNeg(usage.cachedReadTokens, usage.cachedInputTokens, quota.cachedInputTokens),
    reasoningTokens: firstNonNeg(usage.thoughtTokens, usage.reasoningOutputTokens, quota.reasoningOutputTokens),
    numTurns: 1,
  };
  const hasUsage = Object.entries(cost).some(([key, value]) => key !== "numTurns" && value !== undefined);
  return hasUsage ? cost : undefined;
}

function mergeDefined<T extends object>(base: T | undefined, patch: T | undefined): T | undefined {
  if (!base) return patch;
  if (!patch) return base;
  return { ...base, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as T;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max = STEP_TEXT_MAX): string {
  return value.length > max ? `${value.slice(0, max)} …[truncated]` : value;
}

function compact(value: unknown): string {
  if (typeof value === "string") return clip(value);
  try {
    return clip(JSON.stringify(value));
  } catch {
    return "";
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (record.content != null) return contentText(record.content);
  for (const key of ["stdout", "stderr", "output", "message", "result"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  if (typeof record.formatted_output === "string") return record.formatted_output;
  return "";
}

/**
 * Parse raw ACP JSON-RPC (the output of `acpx --format json --json-strict`).
 * The parser is protocol-first: session/update drives trace/progress, while the
 * terminal session/prompt response supplies the exact token breakdown.
 */
export function makeAcpStreamConsumer(
  onProgress: (progress: { step: number; label: string }) => void,
  workdir: string,
): { feed: (chunk: string) => void; result: () => AcpStreamFinal } {
  let buffer = "";
  let progressStep = 0;
  let finalText = "";
  const out: AcpStreamFinal = { artifacts: [], transcript: [] };
  const textSteps = new Map<string, number>();
  const toolSteps = new Map<string, { index: number; name: string; resultRecorded: boolean }>();
  const artifactKinds = new Map<string, "created" | "edited">();
  const root = path.resolve(workdir);

  const progress = (label: string): void => {
    const line = oneLine(label);
    if (line) onProgress({ step: (progressStep += 1), label: clip(line, 80) });
  };
  const addStep = (step: TranscriptStep): number => {
    if (out.transcript.length >= MAX_STEPS) return -1;
    out.transcript.push(step);
    return out.transcript.length - 1;
  };
  const appendText = (key: string, prefix: string, text: string): void => {
    if (!text) return;
    const existing = textSteps.get(key);
    if (existing !== undefined) {
      const step = out.transcript[existing];
      if (step) step.text = clip(`${step.text ?? ""}${text}`);
      return;
    }
    const index = addStep({ kind: "text", text: clip(`${prefix}${text}`) });
    if (index >= 0) textSteps.set(key, index);
  };
  const markArtifact = (candidate: unknown, explicitKind?: "created" | "edited"): void => {
    if (typeof candidate !== "string" || !candidate.trim()) return;
    const abs = path.resolve(root, candidate);
    if (abs !== root && !abs.startsWith(root + path.sep)) return;
    const rel = path.relative(root, abs);
    if (!rel) return;
    const kind: "created" | "edited" = explicitKind ?? (fs.existsSync(abs) ? "edited" : "created");
    if (artifactKinds.get(rel) !== "created") artifactKinds.set(rel, kind);
  };
  const diffArtifacts = (content: unknown): void => {
    const items = Array.isArray(content) ? content : content ? [content] : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, any>;
      if (record.type === "diff" && typeof record.path === "string") {
        markArtifact(record.path, record?._meta?.kind === "add" ? "created" : "edited");
      }
      if (record.content != null) diffArtifacts(record.content);
    }
  };
  const recordTool = (update: any): void => {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : `tool-${toolSteps.size}`;
    let state = toolSteps.get(id);
    if (!state) {
      const name = String(update.title || update.kind || "tool");
      const input = compact(update.rawInput ?? { kind: update.kind, locations: update.locations });
      const index = addStep({ kind: "tool", name, ...(input ? { input } : {}) });
      state = { index, name, resultRecorded: false };
      toolSteps.set(id, state);
      progress(name);
    } else if (state.index >= 0) {
      const step = out.transcript[state.index];
      if (step && typeof update.title === "string") {
        step.name = update.title;
        state.name = update.title;
      }
      if (step && update.rawInput !== undefined) step.input = compact(update.rawInput);
    }
    const locations = Array.isArray(update.locations) ? update.locations : [];
    diffArtifacts(update.content);
    if (update.kind === "edit" || /\b(edit|write|patch|file change)\b/i.test(String(update.title ?? ""))) {
      for (const location of locations) markArtifact(location?.path ?? location?.file ?? location?.uri);
    }
    const terminal = ["completed", "failed", "rejected", "cancelled"].includes(String(update.status));
    if (terminal && !state.resultRecorded) {
      const text = contentText(update.content) || contentText(update.rawOutput) || String(update.status);
      if (text.trim()) addStep({ kind: "result", text: clip(text.trim()) });
      state.resultRecorded = true;
      progress(`${update.title || update.kind || state.name}: ${update.status}`);
    }
  };
  const handleUpdate = (params: any): void => {
    if (typeof params?.sessionId === "string") out.sessionId = params.sessionId;
    const update = params?.update;
    if (!update || typeof update !== "object") return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        const id = `message:${update.messageId ?? textSteps.size}`;
        appendText(id, "", text);
        if (update?._meta?.codex?.phase === "final_answer" || update?._meta?.codex?.phase == null) {
          finalText = clip(`${finalText}${text}`, FINAL_TEXT_MAX);
        }
        progress(finalText || text);
        break;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        appendText(`thought:${update.messageId ?? textSteps.size}`, "Thinking: ", text);
        progress(`Thinking: ${text}`);
        break;
      }
      case "tool_call":
      case "tool_call_update":
        recordTool(update);
        break;
      case "plan":
        appendText(`plan:${textSteps.size}`, "Plan: ", contentText(update.content ?? update.entries ?? update));
        progress("Updating plan");
        break;
      case "usage_update": {
        const context: RunCost = {
          contextTokens: nonNeg(update.used),
          contextWindow: nonNeg(update.size),
        };
        out.cost = mergeDefined(out.cost, context);
        break;
      }
    }
  };
  const handleLine = (line: string): void => {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.method === "session/update") handleUpdate(event.params);
    if (typeof event?.result?.sessionId === "string") out.sessionId = event.result.sessionId;
    if (typeof event?.result?.stopReason === "string") {
      out.stopReason = event.result.stopReason;
      out.cost = mergeDefined(out.cost, costFromAcpResult(event.result));
    }
    if (event?.error && typeof event.error === "object") {
      const detail = contentText(event.error.data);
      out.error = `${event.error.message || "ACP error"}${detail ? `: ${oneLine(detail)}` : ""}`;
    }
  };
  const feed = (chunk: string): void => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleLine(line);
    }
  };
  const result = (): AcpStreamFinal => {
    const rest = buffer.trim();
    buffer = "";
    if (rest) handleLine(rest);
    out.finalText = finalText.trim() || undefined;
    out.artifacts = [...artifactKinds].map(([artifactPath, kind]) => ({ path: artifactPath, kind }));
    return out;
  };
  return { feed, result };
}
