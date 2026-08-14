/**
 * Kernel Run transcript ingress + read model.
 *
 * This is deliberately outside `decide`: transcript entries are observational
 * append data, not Task/Run state. The run lease remains the authority, and the
 * server accepts only this small normalized vocabulary. Unknown provider fields
 * never cross the boundary.
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { kernelRunTranscriptChunks, kernelRuns } from "../db/schema.js";
import { resolveLease } from "../gateway/tokens.js";

export const TRANSCRIPT_REQUEST_CAP = 256 * 1024;
export const TRANSCRIPT_RUN_CAP = 2 * 1024 * 1024;
export const TRANSCRIPT_ENTRY_CAP = 2_000;
export const TRANSCRIPT_TEXT_CAP = 8 * 1024;
export const TRANSCRIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type RunTranscriptEntry =
  | { seq: number; at: string; kind: "phase"; phase: "workflow" | "agent" | "finishing"; text: string }
  | { seq: number; at: string; kind: "agent-message"; text: string }
  | { seq: number; at: string; kind: "tool"; toolCallId: string; title: string; status: "started" | "done" | "failed"; path?: string; text?: string }
  | { seq: number; at: string; kind: "error"; text: string }
  | { seq: number; at: string; kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number };

export interface TranscriptChunkInput {
  entries: RunTranscriptEntry[];
  endSeq: number;
  final?: boolean;
  partial?: boolean;
  truncated?: boolean;
}

export interface TranscriptPage {
  entries: RunTranscriptEntry[];
  nextSeq: number;
  hasMore: boolean;
  capture: { status: "complete" | "partial" | "unavailable"; entries: number; bytes: number; truncated: boolean };
}

type Refusal = { ok: false; status: number; code: string; message: string };
type Accepted = { ok: true; duplicate: boolean; nextSeq: number };

const text = (value: unknown, required = true): string | undefined => {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (required && !clean) return undefined;
  return clean.slice(0, TRANSCRIPT_TEXT_CAP);
};
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const iso = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Defensive token-like value masking. The primary protection is structural
 * allowlisting above this layer; this catches common accidental leaks in the
 * remaining human text without claiming perfect secret detection. */
export function redactTranscriptText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(authorization)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|rk|mk|dk)_[A-Za-z0-9_-]{12,}\b/g, "[redacted token]");
}

function normalizeEntry(raw: unknown): RunTranscriptEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const seq = Number.isSafeInteger(e.seq) && Number(e.seq) >= 0 ? Number(e.seq) : undefined;
  const at = iso(e.at);
  if (seq === undefined || !at || typeof e.kind !== "string") return null;
  const clean = (v: unknown, required = true) => {
    const value = text(v, required);
    return value === undefined ? undefined : redactTranscriptText(value);
  };
  if (e.kind === "phase" && (e.phase === "workflow" || e.phase === "agent" || e.phase === "finishing")) {
    const value = clean(e.text); return value ? { seq, at, kind: "phase", phase: e.phase, text: value } : null;
  }
  if (e.kind === "agent-message") {
    const value = clean(e.text); return value ? { seq, at, kind: "agent-message", text: value } : null;
  }
  if (e.kind === "error") {
    const value = clean(e.text); return value ? { seq, at, kind: "error", text: value } : null;
  }
  if (e.kind === "tool" && (e.status === "started" || e.status === "done" || e.status === "failed")) {
    const toolCallId = clean(e.toolCallId);
    const title = clean(e.title);
    if (!toolCallId || !title) return null;
    const path = clean(e.path, false);
    const result = clean(e.text, false);
    return { seq, at, kind: "tool", toolCallId, title, status: e.status, ...(path ? { path } : {}), ...(result ? { text: result } : {}) };
  }
  if (e.kind === "usage") {
    const inputTokens = finite(e.inputTokens), outputTokens = finite(e.outputTokens), costUsd = finite(e.costUsd);
    return { seq, at, kind: "usage", ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
  }
  return null;
}

export function normalizeTranscriptChunk(raw: unknown): { ok: true; value: TranscriptChunkInput } | Refusal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, code: "INVALID_TRANSCRIPT", message: "body must be a transcript chunk" };
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.entries) || body.entries.length > 200) return { ok: false, status: 400, code: "INVALID_TRANSCRIPT", message: "entries must be an array of at most 200 items" };
  const entries: RunTranscriptEntry[] = [];
  for (const rawEntry of body.entries) {
    const entry = normalizeEntry(rawEntry);
    if (!entry) return { ok: false, status: 400, code: "INVALID_TRANSCRIPT", message: "transcript entry is invalid" };
    entries.push(entry);
  }
  for (let i = 1; i < entries.length; i++) if (entries[i]!.seq !== entries[i - 1]!.seq + 1) return { ok: false, status: 400, code: "INVALID_TRANSCRIPT", message: "entry sequence must be contiguous" };
  const endSeq = Number.isSafeInteger(body.endSeq) && Number(body.endSeq) >= 0 ? Number(body.endSeq) : -1;
  const expectedEnd = entries.length ? entries[entries.length - 1]!.seq : endSeq;
  if (endSeq !== expectedEnd) return { ok: false, status: 400, code: "INVALID_TRANSCRIPT", message: "endSeq does not match entries" };
  return { ok: true, value: { entries, endSeq, final: body.final === true, partial: body.partial === true, truncated: body.truncated === true } };
}

export async function appendRunTranscript(token: string, runId: string, raw: unknown): Promise<Accepted | Refusal> {
  const lease = await resolveLease(token);
  if (!lease?.kernelTeamId || lease.runId !== runId || lease.state !== "active") return { ok: false, status: 401, code: "UNAUTHORIZED", message: "run credential is not active for this Run" };
  const parsed = normalizeTranscriptChunk(raw);
  if (!parsed.ok) return parsed;
  const chunk = parsed.value;
  const startSeq = chunk.entries[0]?.seq ?? chunk.endSeq;
  const encoded = JSON.stringify(chunk.entries);
  const byteLength = Buffer.byteLength(encoded);
  if (byteLength > TRANSCRIPT_REQUEST_CAP) return { ok: false, status: 413, code: "TRANSCRIPT_TOO_LARGE", message: "transcript chunk is too large" };
  const [run, totals, duplicate] = await Promise.all([
    db.select({ id: kernelRuns.id }).from(kernelRuns).where(and(eq(kernelRuns.teamId, lease.kernelTeamId), eq(kernelRuns.id, runId))).limit(1),
    db.select({ bytes: sql<number>`coalesce(sum(${kernelRunTranscriptChunks.byteLength}), 0)`, entries: sql<number>`coalesce(sum(${kernelRunTranscriptChunks.entryCount}), 0)` }).from(kernelRunTranscriptChunks).where(and(eq(kernelRunTranscriptChunks.teamId, lease.kernelTeamId), eq(kernelRunTranscriptChunks.runId, runId))),
    db.select({ startSeq: kernelRunTranscriptChunks.startSeq }).from(kernelRunTranscriptChunks).where(and(eq(kernelRunTranscriptChunks.teamId, lease.kernelTeamId), eq(kernelRunTranscriptChunks.runId, runId), eq(kernelRunTranscriptChunks.startSeq, startSeq))).limit(1),
  ]);
  if (!run.length) return { ok: false, status: 404, code: "RUN_NOT_FOUND", message: "Run not found" };
  if (duplicate.length) return { ok: true, duplicate: true, nextSeq: chunk.endSeq + 1 };
  const currentBytes = Number(totals[0]?.bytes ?? 0), currentEntries = Number(totals[0]?.entries ?? 0);
  if (currentBytes + byteLength > TRANSCRIPT_RUN_CAP || currentEntries + chunk.entries.length > TRANSCRIPT_ENTRY_CAP) return { ok: false, status: 413, code: "TRANSCRIPT_LIMIT", message: "Run transcript limit reached" };
  await db.insert(kernelRunTranscriptChunks).values({
    teamId: lease.kernelTeamId, runId, startSeq, endSeq: chunk.endSeq,
    receivedAt: new Date().toISOString(), byteLength, entryCount: chunk.entries.length, final: chunk.final ?? false,
    partial: chunk.partial ?? false,
    truncated: chunk.truncated ?? false, data: chunk.entries,
  }).onConflictDoNothing();
  return { ok: true, duplicate: false, nextSeq: chunk.endSeq + 1 };
}

export async function readRunTranscript(teamId: string, runId: string, after = -1, limit = 200): Promise<TranscriptPage | null> {
  const run = await db.select({ id: kernelRuns.id, state: kernelRuns.state }).from(kernelRuns).where(and(eq(kernelRuns.teamId, teamId), eq(kernelRuns.id, runId))).limit(1);
  if (!run.length) return null;
  const rows = await db.select().from(kernelRunTranscriptChunks).where(and(eq(kernelRunTranscriptChunks.teamId, teamId), eq(kernelRunTranscriptChunks.runId, runId))).orderBy(asc(kernelRunTranscriptChunks.startSeq));
  const all = rows.flatMap((row) => Array.isArray(row.data) ? row.data as RunTranscriptEntry[] : []).filter((entry) => entry.seq > after);
  const entries = all.slice(0, Math.max(1, Math.min(limit, 500)));
  const count = rows.reduce((sum, row) => sum + row.entryCount, 0);
  const bytes = rows.reduce((sum, row) => sum + row.byteLength, 0);
  const final = rows.some((row) => row.final);
  let expectedSeq = 0;
  let sequenceGap = false;
  for (const row of rows) {
    if (row.startSeq !== expectedSeq) sequenceGap = true;
    if (row.entryCount > 0) expectedSeq = row.endSeq + 1;
  }
  const partial = sequenceGap || rows.some((row) => row.partial);
  return {
    entries, nextSeq: entries.at(-1)?.seq ?? after, hasMore: all.length > entries.length,
    capture: { status: final && !partial ? "complete" : rows.length ? "partial" : "unavailable", entries: count, bytes, truncated: rows.some((row) => row.truncated) },
  };
}

export async function pruneRunTranscripts(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - TRANSCRIPT_RETENTION_MS).toISOString();
  const removed = await db.delete(kernelRunTranscriptChunks).where(lt(kernelRunTranscriptChunks.receivedAt, cutoff)).returning({ runId: kernelRunTranscriptChunks.runId });
  return removed.length;
}
