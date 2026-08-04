import { and, asc, count, desc, eq, gt, isNotNull, isNull, lte, ne, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { events, objects, type KernelEvent, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import { runs } from "../db/schema.js";
import { appendOrganicEvent, applyTransitionIn, applyUpdateIn, buildFieldDiff, createObjectIn, sameValue, type WritableFields } from "./applyTransition.js";
import { parseDate, parseKindArtifact, serializeKindArtifact, type ArtifactProjection } from "./artifactSeam.js";
import { derivedEventId } from "./ids.js";
import { notifyRunQueued, queueKernelRun } from "./runQueue.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import { nextOccurrenceAfter } from "./schedule.js";
import type { ApiContext } from "./apiAuth.js";
import { LOOP_STATUSES, type EventDiff, type ObjectKind } from "./types.js";

export type ApiResult<T> = { ok: true; status?: number; value: T } | { ok: false; error: ApiRefusal };

export function objectShape(row: KernelObject): Record<string, unknown> {
  const common = { id: row.id, kind: row.kind, team: row.teamId, status: row.status, title: row.title, key: row.key, payload: row.payload ?? {}, body: row.body ?? "", createdByRun: row.createdByRun, createdByLoop: row.createdByLoop, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (row.kind === "task") return { ...common, followUpAt: row.followUpAt, pendingQuestion: row.pendingQuestion, watcher: row.watcher, closedAt: row.closedAt };
  if (row.kind === "doc") return { ...common, format: row.format ?? "markdown" };
  return { ...common, cron: row.cron, timezone: row.timezone, nextFire: row.nextFire, workdir: row.workdir };
}

export async function createFromArtifact(kind: ObjectKind, raw: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const parsed = parseKindArtifact(kind, raw, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const p = parsed.value;
  if (kind === "loop") {
    // Creating a loop is GOVERNANCE (design §4): it mints a standing cadence and
    // a new actor in the system, so it is the owner's act. Double-covered with the
    // route's own `human` requirement — either alone is sufficient, both together
    // leave no seam, and the refusal names the proposal path rather than a wall.
    if (context.mode !== "human") {
      return { ok: false, error: notHuman(context, "creating a loop is governance and is the owner's act", "propose it: `loopany task create --file <path> --needs-human \"create a loop that …\" --watcher <your-loop-id>`") };
    }
    // `createObjectIn` arms `next_fire` by CALLING croner, which throws on an
    // unreadable expression. Validated here so a typo is a teaching 400 rather
    // than a 500 from inside the transaction.
    if (p.cron) {
      try { nextOccurrenceAfter(p.cron, null, now); }
      catch { return { ok: false, error: refusal("BAD_CRON", `cron ${JSON.stringify(p.cron)} is not a cron expression this server can read`, [{ path: "cron", message: "unreadable cron expression", got: p.cron, expected: "0 7 * * *" }], "five fields: minute hour day-of-month month day-of-week; omit cron entirely for a loop that only ever runs on demand") }; }
    }
  }
  const result = await createObjectInTransaction({ kind, p, context, now });
  if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
  const differingFields = result.created ? [] : expressedDiffs(result.object, p, kind);
  const name = kind === "task" ? "task" : kind === "doc" ? "doc" : "loop";
  return { ok: true, status: result.created ? 201 : 200, value: {
    created: result.created, ...(result.created ? {} : { contentDiffers: differingFields.length > 0, differingFields }),
    // An idempotent hit writes nothing, so it reports no event — the caller must
    // be able to tell a fresh effect from a replay (spec §1.4).
    [name]: objectShape(result.object), event: result.created ? result.event?.id ?? null : null,
    ...(!result.created && differingFields.length ? { notice: { code: "KEY_EXISTS_CONTENT_DIFFERS", message: `key "${p.key}" already names ${result.object.id}; the submitted file differs from it and was not applied`, hint: applyDifferingHint(kind, result.object.id, name) } } : {}),
  } };
}

/**
 * A replay's "your file was not applied" notice must name a route that EXISTS.
 * Tasks and docs have the human whole-file PATCH; a loop does not — `PATCH
 * /api/loops/:id` is spec'd but unbuilt, and `POST /api/loops/:id/evolve` is
 * agent-only — so the loop hint teaches the two paths a charter change really
 * has today rather than a 404.
 */
function applyDifferingHint(kind: ObjectKind, id: string, name: string): string {
  return kind === "loop"
    ? `a loop charter has no human edit route yet: a run of this loop applies it with POST /api/loops/${id}/evolve (agent-only, and a differing cron: or workdir: is refused APPROVAL_REQUIRED), or edit it on the loop page`
    : `to change it: PATCH /api/${name}s/${id} with the same file`;
}

async function createObjectInTransaction(input: { kind: ObjectKind; p: ReturnType<typeof projection>; context: ApiContext; now: Date }) {
  const { kind, p, context, now } = input;
  return db.transaction((tx) => createObjectIn(tx as unknown as store.KernelExec, {
    teamId: context.teamId, kind, actor: context.actor, now: now.toISOString(), key: p.key,
    title: p.title, body: p.body, payload: p.payload,
    ...(kind === "task" ? { followUpAt: p.followUpAt, pendingQuestion: p.pendingQuestion, watcher: p.watcher } : {}),
    ...(kind === "doc" ? { format: p.format } : {}),
    ...(kind === "loop" ? { cron: p.cron, workdir: p.workdir } : {}),
    createdByRun: context.run?.id ?? null, createdByLoop: context.run?.loopId ?? null,
  }));
}

function projection(p: ArtifactProjection) { return p; }

function expressedDiffs(row: KernelObject, p: ArtifactProjection, kind: ObjectKind): string[] {
  const pairs: [string, unknown, unknown][] = [["title", row.title, p.title], ["body", row.body ?? "", p.body], ["payload", row.payload ?? null, p.payload]];
  if (kind === "task") pairs.push(["followUpAt", row.followUpAt, p.followUpAt], ["watcher", row.watcher, p.watcher], ["pendingQuestion", row.pendingQuestion, p.pendingQuestion]);
  if (kind === "doc") pairs.push(["format", row.format ?? "markdown", p.format]);
  if (kind === "loop") pairs.push(["cron", row.cron, p.cron], ["workdir", row.workdir, p.workdir]);
  return pairs.filter(([, a, b]) => !sameValue(a, b)).map(([key]) => key);
}

export async function listTasks(context: ApiContext, query: URLSearchParams, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const allowed = new Set(["status", "due", "watcher", "creator", "since", "limit", "cursor"]);
  const unknown = [...query.keys()].find((key) => !allowed.has(key));
  if (unknown) return { ok: false, error: refusal("UNKNOWN_FILTER", `unknown task filter "${unknown}"`, [{ path: unknown, message: "unknown filter", got: unknown }], `accepted filters: ${[...allowed].join(", ")}`) };
  const status = query.get("status") ?? "open";
  if (!(["open", "closed"] as string[]).includes(status)) return { ok: false, error: refusal("UNKNOWN_FILTER", "status must be open or closed") };
  if (query.has("due") && query.get("due") !== "true") return { ok: false, error: refusal("UNKNOWN_FILTER", "due accepts only the literal value true") };
  const limit = Number(query.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: refusal("UNKNOWN_FILTER", "limit must be from 1 to 200") };
  const conds = [eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.status, status)];
  if (query.get("due") === "true") conds.push(lte(objects.followUpAt, now.toISOString()));
  const watcher = query.get("watcher");
  if (watcher === "none") conds.push(isNull(objects.watcher)); else if (watcher) { if (!watcher.startsWith("loop-")) return { ok: false, error: refusal("SCHEMA_VIOLATION", "watcher must be an explicit loop id", [{ path: "watcher", message: "must start with loop-", got: watcher, expected: "loop-<id>" }], "there is no self keyword; use the loop id from the work order") }; conds.push(eq(objects.watcher, watcher)); }
  const creator = query.get("creator"); if (creator) { if (!creator.startsWith("loop-")) return { ok: false, error: refusal("SCHEMA_VIOLATION", "creator must be an explicit loop id", [{ path: "creator", message: "must start with loop-", got: creator, expected: "loop-<id>" }]) }; conds.push(eq(objects.createdByLoop, creator)); }
  const since = query.get("since");
  if (since) { const date = lookbackDate(since, now); if (!date) return { ok: false, error: refusal("BAD_DATE", "since must be a bare lookback such as 14d or an RFC3339 timestamp") }; conds.push(gt(objects.updatedAt, date)); }
  const cursor = query.get("cursor"); if (cursor) conds.push(gt(objects.id, cursor));
  const rows = await db.select().from(objects).where(and(...conds)).orderBy(asc(objects.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const truncated = rows.length > limit;
  // `total` is what lets the CLI print "count: 30 of 112 total" (CLI spec §6.1)
  // instead of a silent clip. Counted only when the page actually overflowed.
  const total = truncated ? Number((await db.select({ n: count() }).from(objects).where(and(...conds)))[0]?.n ?? page.length) : page.length;
  // `viewerLoop` is the caller's OWN loop id, resolved from the invisible run
  // context. It is what lets the CLI inline a real id into its next-step hints
  // instead of a placeholder — the agent never retypes its identity (§3.5).
  return { ok: true, value: { tasks: page.map(taskListShape), total, nextCursor: truncated ? page.at(-1)?.id ?? null : null, truncated, viewerLoop: context.run?.loopId ?? null } };
}

export async function showObject(kind: ObjectKind, id: string, context: ApiContext, eventLimit = 20): Promise<ApiResult<Record<string, unknown>>> {
  const row = await store.getObject(undefined, id);
  if (!row || row.teamId !== context.teamId) return { ok: false, error: refusal("NOT_FOUND", `${id} was not found`) };
  if (row.kind !== kind) return { ok: false, error: refusal("WRONG_KIND", `${id} is a ${row.kind}, not a ${kind}`, [{ path: "id", message: "wrong kind", got: id, expected: `${kind}-<id>` }], `use the ${row.kind} verb`) };
  const normalizedLimit = Math.max(0, Math.min(200, eventLimit));
  const allEvents = await store.listObjectEvents(undefined, id);
  const history = normalizedLimit === 0 ? [] : allEvents.slice(-normalizedLimit);
  const value: Record<string, unknown> = { [kind]: objectShape(row), events: history.map(eventShape) };
  if (kind === "task") {
    value.runs = await db.select({ id: runs.id, state: runs.queueState, scope: runs.scope, reason: runs.reason, finishedAt: runs.finishedAt }).from(runs).where(or(eq(runs.scope, `task:${id}`), eq(runs.id, row.createdByRun ?? ""))).orderBy(desc(runs.ts));
  }
  return { ok: true, value };
}

export function objectArtifact(row: KernelObject): string {
  return serializeKindArtifact(row.kind, { title: row.title, key: row.key, body: row.body ?? "", payload: row.payload, followUpAt: row.followUpAt, watcher: row.watcher, pendingQuestion: row.pendingQuestion, format: (row.format ?? "markdown") as "markdown" | "html", cron: row.cron, workdir: row.workdir });
}

export async function replaceFromArtifact(kind: ObjectKind, id: string, raw: string, context: ApiContext, now = new Date(), eventKind?: string): Promise<ApiResult<Record<string, unknown>>> {
  const parsed = parseKindArtifact(kind, raw, now); if (!parsed.ok) return parsed;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const before = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(before, kind, context.teamId); if (guard) return guard;
    if (parsed.value.key !== null && parsed.value.key !== before!.key) return { ok: false, error: refusal("IMMUTABLE_KEY", "key cannot be changed", [{ path: "key", message: "fixed at creation", got: parsed.value.key, expected: before!.key ?? "(remove the key)" }], "restore the stored key or remove the line") };
    if (context.mode === "agent" && kind === "task" && before!.pendingQuestion && parsed.value.pendingQuestion !== before!.pendingQuestion) return { ok: false, error: refusal("NOT_HUMAN", "a run cannot clear or replace a pending question", [], "a human answers or withdraws it") };
    if (kind === "loop" && context.run && context.run.loopId !== id) return { ok: false, error: notYourLoop(context, id) };
    if (kind === "loop" && before!.status === "retired") return { ok: false, error: refusal("RETIRED", `${id} is retired and its charter is frozen`) };
    if (kind === "loop" && parsed.value.cron !== before!.cron) return { ok: false, error: refusal("APPROVAL_REQUIRED", "changing this loop's cadence requires an approval key", [{ path: "cron", message: "changed on the free-zone endpoint" }], `use POST /api/loops/${id} with cron and a human answer event`) };
    // WHERE a loop executes is governance exactly like WHEN it executes: moving
    // the bound directory moves every future run's blast radius, so an evolve
    // pass may not do it silently (captain ruling 2026-08-04).
    if (kind === "loop" && parsed.value.workdir !== before!.workdir) return { ok: false, error: refusal("APPROVAL_REQUIRED", "changing this loop's bound working directory requires an approval key", [{ path: "workdir", message: "changed on the free-zone endpoint", got: parsed.value.workdir ?? "(none)", expected: before!.workdir ?? "(none)" }], `use POST /api/loops/${id} with workdir and a human answer event`) };
    const fields: WritableFields = { title: parsed.value.title, body: parsed.value.body, payload: parsed.value.payload };
    if (kind === "task") Object.assign(fields, { followUpAt: parsed.value.followUpAt, watcher: parsed.value.watcher, pendingQuestion: parsed.value.pendingQuestion });
    if (kind === "doc") fields.format = parsed.value.format;
    const result = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields, eventKind: eventKind ?? (kind === "loop" ? "charter-evolved" : "object-updated") });
    return kernelUpdateResult(kind, result);
  });
}

export async function patchTask(id: string, body: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const allowed = ["followUp", "watcher", "needsHuman", "title", "payloadMerge", "body"];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: refusal("INVALID_BODY", "task patch must be a JSON object") };
  const rec = body as Record<string, unknown>; const unknown = Object.keys(rec).find((k) => !allowed.includes(k));
  if (unknown) return { ok: false, error: unknownJsonKey("task patch", unknown, allowed) };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const before = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(before, "task", context.teamId); if (guard) return guard;
    const fields: WritableFields = {};
    if (Object.hasOwn(rec, "followUp")) { if (rec.followUp === null) fields.followUpAt = null; else if (typeof rec.followUp === "string") { const d = parseDate(rec.followUp, now); if (!d) return { ok: false, error: refusal("BAD_DATE", "followUp is not a date this server accepts") }; fields.followUpAt = d; } else return { ok: false, error: refusal("SCHEMA_VIOLATION", "followUp must be a string or null") }; }
    if (Object.hasOwn(rec, "watcher")) { if (rec.watcher !== null && (typeof rec.watcher !== "string" || !rec.watcher.startsWith("loop-"))) return { ok: false, error: refusal("SCHEMA_VIOLATION", "watcher must be a loop id or null") }; fields.watcher = rec.watcher as string | null; }
    if (Object.hasOwn(rec, "needsHuman")) { if (rec.needsHuman !== null && (typeof rec.needsHuman !== "string" || !rec.needsHuman.trim())) return { ok: false, error: refusal("SCHEMA_VIOLATION", "needsHuman must be non-empty text or null") }; if (context.mode === "agent" && before!.pendingQuestion && rec.needsHuman !== before!.pendingQuestion) return { ok: false, error: refusal("NOT_HUMAN", "a run cannot clear or replace a pending question", [], "a human answers it in the inbox") }; fields.pendingQuestion = rec.needsHuman as string | null; }
    if (Object.hasOwn(rec, "title")) { if (typeof rec.title !== "string") return { ok: false, error: refusal("SCHEMA_VIOLATION", "title must be text") }; fields.title = rec.title; }
    if (Object.hasOwn(rec, "body")) { if (typeof rec.body !== "string") return { ok: false, error: refusal("SCHEMA_VIOLATION", "body must be text") }; fields.body = rec.body; }
    if (Object.hasOwn(rec, "payloadMerge")) { if (!rec.payloadMerge || typeof rec.payloadMerge !== "object" || Array.isArray(rec.payloadMerge)) return { ok: false, error: refusal("SCHEMA_VIOLATION", "payloadMerge must be one JSON object") }; fields.payload = mergePayload(before!.payload, rec.payloadMerge as Record<string, unknown>); }
    const withdrawing = context.mode === "human" && before!.pendingQuestion && fields.pendingQuestion === null;
    const result = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields, ...(withdrawing ? { eventKind: "question-withdrawn" } : {}) });
    return kernelUpdateResult("task", result);
  });
}

export async function closeTask(id: string, note: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  if (typeof note !== "string" || !note.trim()) return { ok: false, error: refusal("INVALID_BODY", "close requires a non-empty note", [{ path: "note", message: "required" }], "pass one sentence attesting why the task is done") };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const before = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(before, "task", context.teamId); if (guard) return guard;
    if (before!.pendingQuestion?.trim()) return { ok: false, error: refusal("OPEN_QUESTION", `${id} cannot be closed while a question is waiting for a human`, [{ path: "pendingQuestion", message: "must be empty to close", got: before!.pendingQuestion }], `a human answers it at POST /api/tasks/${id}/verdict`) };
    if (before!.status === "closed") {
      const original = [...await store.listObjectEvents(tx, id)].reverse().find((event) => event.kind === "task-closed")?.note ?? null;
      const differs = original !== note;
      return { ok: true, value: { changed: false, task: objectShape(before!), event: null, contentDiffers: differs, differingFields: differs ? ["note"] : [], ...(differs ? { notice: { code: "CLOSE_NOTE_DIFFERS", message: "the submitted note was not recorded; the original closure stands", hint: "close is idempotent — inspect the original task-closed event" } } : {}) } };
    }
    const result = await applyTransitionIn(tx, { objectId: id, transition: "close", actor: context.actor, now: now.toISOString(), note });
    if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
    return { ok: true, value: { changed: true, task: objectShape(result.object), event: result.event.id } };
  });
}

export async function governLoop(id: string, body: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  if (context.run?.loopId !== id) return { ok: false, error: notYourLoop(context, id) };
  const allowed = ["cron", "workdir", "approval"]; if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: refusal("INVALID_BODY", "loop update requires a JSON object") };
  const rec = body as Record<string, unknown>; const unknown = Object.keys(rec).find((k) => !allowed.includes(k)); if (unknown) return { ok: false, error: unknownJsonKey("loop update", unknown, allowed) };
  // The two governed execution facets: WHEN a loop runs and WHERE it runs. Each
  // is optional, one of them is required, and both ride the same approval gate.
  if (rec.cron !== undefined && typeof rec.cron !== "string") return { ok: false, error: refusal("INVALID_BODY", "cron must be a cron expression string") };
  if (rec.workdir !== undefined && rec.workdir !== null && typeof rec.workdir !== "string") return { ok: false, error: refusal("INVALID_BODY", "workdir must be an absolute path string or null") };
  if (rec.cron === undefined && rec.workdir === undefined) return { ok: false, error: refusal("INVALID_BODY", "cron or workdir is required", [], "governance moves a loop's cadence, its bound directory, or both") };
  const workdir = rec.workdir === undefined ? undefined : (rec.workdir as string | null);
  if (typeof workdir === "string" && !workdir.startsWith("/")) return { ok: false, error: refusal("SCHEMA_VIOLATION", "workdir must be an absolute path", [{ path: "workdir", message: "must be an absolute path", got: workdir, expected: "/Users/you/Workspace/your-repo" }]) };
  if (typeof rec.approval !== "string") return { ok: false, error: refusal("APPROVAL_REQUIRED", "changing this loop's cadence or bound directory requires an approval key", [{ path: "approval", message: "is required", expected: "ev-<id> of a human answer" }]) };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const loop = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(loop, "loop", context.teamId); if (guard) return guard;
    if (loop!.status === "retired") return { ok: false, error: refusal("RETIRED", `${id} is retired`) };
    const approval = await store.getEvent(tx, rec.approval as string);
    if (!approval || approval.teamId !== loop!.teamId) return { ok: false, error: refusal("APPROVAL_UNKNOWN", `${rec.approval} is not an approval event in this team`) };
    if (approval.entrance !== "human") return { ok: false, error: refusal("APPROVAL_NOT_HUMAN", `${approval.id} was not entered by a human`, [{ path: "approval", message: "entrance must be human", got: approval.entrance, expected: "human" }]) };
    const task = approval.objectId ? await store.getObject(tx, approval.objectId) : undefined;
    if (!task || task.teamId !== loop!.teamId || task.kind !== "task" || task.createdByLoop !== id) return { ok: false, error: refusal("APPROVAL_FOREIGN", `${approval.id} hangs on a task this loop did not create`, [{ path: "approval", message: "the approving task must have been created by this loop", got: task?.createdByLoop ?? "none", expected: id }]) };
    const fields: WritableFields = {};
    if (rec.cron !== undefined) {
      const cron = rec.cron as string;
      let computedNextFire: string; try { computedNextFire = nextOccurrenceAfter(cron, loop!.timezone, now); } catch { return { ok: false, error: refusal("BAD_CRON", `cron "${cron}" is not valid in this loop's timezone`) }; }
      Object.assign(fields, { cron, nextFire: loop!.status === "active" ? computedNextFire : null });
    }
    if (workdir !== undefined) fields.workdir = workdir;
    const approvalBlock = { event: approval.id, entrance: approval.entrance, actor: approval.actorId, task: task.id, ts: approval.ts };
    const result = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields, eventKind: "loop-updated", eventPayload: { approval: approvalBlock } });
    if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
    return { ok: true, value: { changed: result.changed, loop: objectShape(result.object), event: result.event?.id ?? null, diff: result.event?.diff ?? {}, approval: approvalBlock, ...(loop!.status === "paused" ? { notice: { code: "LOOP_STILL_PAUSED", message: "the loop's governed settings changed but the loop remains paused", hint: "time never un-pauses a loop — a human resumes it" } } : {}) } };
  });
}

// ---------------------------------------------------------------- loop CRUD

/**
 * `GET /api/loops` — the loop roster.
 *
 * DUAL, like `task list`: a read, team-scoped, never ownership-checked. An agent
 * legitimately needs it to resolve the loop id it is about to name as a
 * `--watcher`, and `task list` already exposes those ids, so withholding the
 * roster would buy nothing.
 *
 * ONE filter, `status`, and it takes a VALUE rather than the boolean pair
 * `task list` uses: a loop has THREE states, so no two-flag form spans them
 * honestly. Absent ⇒ the whole roster, retired included — a team's loop count is
 * small by construction, so the useful default is "show me everything I own".
 */
export async function listLoops(context: ApiContext, query: URLSearchParams): Promise<ApiResult<Record<string, unknown>>> {
  const allowed = new Set(["status", "limit", "cursor"]);
  const unknown = [...query.keys()].find((key) => !allowed.has(key));
  if (unknown) return { ok: false, error: refusal("UNKNOWN_FILTER", `unknown loop filter "${unknown}"`, [{ path: unknown, message: "unknown filter", got: unknown }], `accepted filters: ${[...allowed].join(", ")}`) };
  const status = query.get("status");
  if (status && !(LOOP_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: refusal("UNKNOWN_FILTER", `"${status}" is not a loop status`, [{ path: "status", message: "unknown status", got: status, expected: LOOP_STATUSES.join("|") }], "a loop is active, paused or retired — loops never close, and retirement is the terminal state") };
  }
  const limit = Number(query.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: refusal("UNKNOWN_FILTER", "limit must be from 1 to 200") };
  const conds = [eq(objects.teamId, context.teamId), eq(objects.kind, "loop")];
  if (status) conds.push(eq(objects.status, status));
  const cursor = query.get("cursor"); if (cursor) conds.push(gt(objects.id, cursor));
  const rows = await db.select().from(objects).where(and(...conds)).orderBy(asc(objects.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const truncated = rows.length > limit;
  const total = truncated ? Number((await db.select({ n: count() }).from(objects).where(and(...conds)))[0]?.n ?? page.length) : page.length;
  return { ok: true, value: { loops: page.map(loopListShape), total, nextCursor: truncated ? page.at(-1)?.id ?? null : null, truncated, viewerLoop: context.run?.loopId ?? null } };
}

/** The three operational verbs, as data: the CLI path segment → the kernel
 *  transition name → the status it lands on (`kernel/types.ts` TRANSITIONS is
 *  the authority for the from-states). `auto-pause` is deliberately absent: the
 *  circuit breaker is the system's, never a person's, and keeping it off this
 *  map is what makes the timeline's `pause` vs `auto-pause` distinction real. */
export const LOOP_LIFECYCLE = { pause: "paused", resume: "active", retire: "retired" } as const;
export type LoopLifecycleVerb = keyof typeof LOOP_LIFECYCLE;

export function isLoopLifecycleVerb(value: string): value is LoopLifecycleVerb {
  return Object.hasOwn(LOOP_LIFECYCLE, value);
}

/**
 * `POST /api/loops/:id/{pause,resume,retire}` — the operational lifecycle
 * (API spec §1.16, design §4 `active ⇄ paused → retired`).
 *
 * HUMAN ONLY. A run may evolve its own charter (the free zone) and may propose
 * anything else, but it never pauses or retires itself: that is the operational
 * decision the owner keeps.
 *
 * There is no hard delete anywhere in this surface, and that is not an omission:
 * the kernel is event-sourced, so `retire` IS the D in CRUD — terminal, charter
 * frozen (`replaceFromArtifact`/`governLoop` both refuse a retired loop), cadence
 * disarmed by the transition itself, and the whole record still readable.
 *
 * Repeating a verb that already landed is a SUCCESS with `changed: false`, the
 * same ruling `task close` carries: a retry after a dropped connection must be
 * free. Only a move OUT of `retired` is refused, and it is refused by name
 * (`RETIRED`) rather than as a bare illegal-from-state.
 */
export async function loopLifecycle(id: string, verb: LoopLifecycleVerb, body: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  if (context.mode !== "human") {
    return { ok: false, error: notHuman(context, `a loop's lifecycle is the owner's — a run does not ${verb} a loop`, `propose it: \`loopany task create --file <path> --needs-human "${verb} this loop because …" --watcher ${context.run?.loopId ?? "<your-loop-id>"}\``) };
  }
  let note: string | null = null;
  if (body !== undefined && body !== null) {
    if (typeof body !== "object" || Array.isArray(body)) return { ok: false, error: refusal("INVALID_BODY", `loop ${verb} takes an optional JSON object`, [], 'the only field is note: `{"note": "…"}`, or send no body at all') };
    const rec = body as Record<string, unknown>;
    const unknown = Object.keys(rec).find((key) => key !== "note");
    if (unknown) return { ok: false, error: unknownJsonKey(`loop ${verb}`, unknown, ["note"]) };
    if (rec.note !== undefined && rec.note !== null) {
      if (typeof rec.note !== "string" || !rec.note.trim()) return { ok: false, error: refusal("SCHEMA_VIOLATION", "note must be non-empty text or absent", [{ path: "note", message: "must be non-empty text or absent" }]) };
      note = rec.note;
    }
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const before = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(before, "loop", context.teamId); if (guard) return guard;
    const target = LOOP_LIFECYCLE[verb];
    if (before!.status === "retired" && target !== "retired") {
      return { ok: false, error: refusal("RETIRED", `${id} is retired and cannot be ${verb}d`, [{ path: "status", message: "retirement is terminal", got: "retired", expected: "active|paused" }], "there is no un-retire: the charter is frozen and the cadence is gone for good — create a new loop, or read this one's record, which is kept") };
    }
    if (before!.status === target) {
      return { ok: true, value: { changed: false, loop: objectShape(before!), event: null, diff: {} } };
    }
    const result = await applyTransitionIn(tx, { objectId: id, transition: verb, actor: context.actor, now: now.toISOString(), note });
    if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
    return { ok: true, value: { changed: true, loop: objectShape(result.object), event: result.event.id, diff: result.event.diff ?? {} } };
  });
}

/**
 * `POST /api/loops/:id/run-now` — the MANUAL fire (API spec §1.16).
 *
 * HUMAN-ONLY, like the lifecycle verbs: firing a loop off-cadence is an
 * operational act the owner keeps, and a run that could wake itself would be a
 * loop with no cadence at all. It reuses `queueKernelRun`'s `manual` reason, so
 * a manual run is claimed, leased, reported and retried by exactly the machinery
 * a clock fire uses — the only difference is the entrance recorded on the event.
 *
 * `runs_one_queued_idx` (one queued run per loop) is the queue discipline, and a
 * manual fire OBEYS it rather than jumping it: an already-queued run is reported
 * back with `alreadyQueued: true`, the same ruling the verdict path takes. A
 * paused or retired loop refuses — time never un-pauses a loop, and neither does
 * a button.
 */
export async function runLoopNow(id: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  if (context.mode !== "human") {
    return { ok: false, error: notHuman(context, "firing a loop off its cadence is the owner's act", `propose it: \`loopany task create --file <path> --needs-human "run this loop now because …" --watcher ${context.run?.loopId ?? "<your-loop-id>"}\``) };
  }
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const loop = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(loop, "loop", context.teamId); if (guard) return guard;
    if (loop!.status !== "active") {
      return { ok: false as const, error: refusal(loop!.status === "retired" ? "RETIRED" : "PAUSED", `${id} is ${loop!.status}, so it has no runs to fire`, [{ path: "status", message: "only an active loop runs", got: loop!.status, expected: "active" }], loop!.status === "paused" ? `resume it first: POST /api/loops/${id}/resume` : "retirement is terminal — create a new loop") };
    }
    const queued = await queueKernelRun(tx, { loop: loop!, now: now.toISOString(), reason: "manual" });
    if (queued.outcome === "queued") {
      await appendOrganicEvent(tx, {
        teamId: loop!.teamId,
        objectId: loop!.id,
        kind: "run-queued",
        origin: "organic",
        entrance: "human",
        actorId: context.actor.actorId,
        payload: { runId: queued.run!.id, reason: "manual" },
        ts: now.toISOString(),
      });
    }
    return { ok: true as const, value: { queued: queued.outcome === "queued", alreadyQueued: queued.outcome === "loop-busy", run: queued.run ? { id: queued.run.id, state: queued.run.queueState, reason: queued.run.reason } : null, loop: objectShape(loop!) } };
  });
  // Wake any daemon parked on the claim long-poll: without this the manual fire
  // waits out the hold (~20s) for no reason.
  if (result.ok && result.value.queued) notifyRunQueued();
  return result;
}

/** The orphan floor's age: open + unwatched + no follow-up + older than this
 *  reaches the inbox, so nothing can lie down silently forever (design §6). */
export const ORPHAN_AGE_MS = 48 * 3_600_000;

/** One inbox row before it is shaped for a consumer: the task row, why it is
 *  here, and when the question was asked (plus by whom). */
export interface InboxUnionRow {
  task: KernelObject;
  reasons: string[];
  askedAt: string | null;
  askedByRun: string | null;
}

/**
 * THE §6 UNION, single-sourced. Both the raw `GET /api/inbox` (the human CLI's
 * surface) and the composed `GET /api/views/inbox` (the screen's) read it, so
 * the safety floor cannot mean two different things depending on which one you
 * are looking at. It returns ROWS, not a payload shape — each caller shapes.
 */
export async function inboxUnion(teamId: string, now: Date): Promise<{ rows: InboxUnionRow[]; stamp: string }> {
  const stamp = now.toISOString();
  const orphanBefore = new Date(now.getTime() - ORPHAN_AGE_MS).toISOString();
  const rows = await db.select().from(objects).where(and(eq(objects.teamId, teamId), eq(objects.kind, "task"), eq(objects.status, "open"), or(and(isNotNull(objects.pendingQuestion), ne(objects.pendingQuestion, "")), and(lte(objects.followUpAt, stamp), isNull(objects.watcher)), and(isNull(objects.watcher), isNull(objects.followUpAt), lte(objects.createdAt, orphanBefore))))).orderBy(asc(objects.createdAt));
  const withReasons = await Promise.all(rows.map(async (task): Promise<InboxUnionRow> => {
    const reasons: string[] = []; if (task.pendingQuestion?.trim()) reasons.push("question"); if (!task.watcher && task.followUpAt && task.followUpAt <= stamp) reasons.push("due-unwatched"); if (!task.watcher && !task.followUpAt && task.createdAt < orphanBefore) reasons.push("orphan");
    let askedAt: string | null = null; let askedByRun: string | null = null;
    if (reasons.includes("question")) {
      const hs = await store.listObjectEvents(undefined, task.id);
      const asked = [...hs].reverse().find((e) => e.diff?.pendingQuestion?.new === task.pendingQuestion);
      askedAt = asked?.ts ?? task.updatedAt;
      askedByRun = asked?.entrance === "agent" ? asked.actorId : null;
    }
    return { task, reasons, askedAt, askedByRun };
  }));
  withReasons.sort((a, b) => reasonRank(a.reasons) - reasonRank(b.reasons) || a.task.createdAt.localeCompare(b.task.createdAt));
  return { rows: withReasons, stamp };
}

/** The three branch counts plus the total — the badge every inbox surface shows. */
export function inboxCounts(rows: InboxUnionRow[]) {
  const n = (r: string) => rows.filter((i) => i.reasons.includes(r)).length;
  return { question: n("question"), dueUnwatched: n("due-unwatched"), orphan: n("orphan"), total: rows.length };
}

export async function inbox(context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  // The inbox routes HUMAN attention. An agent learns nothing here that
  // `task list` does not already give it (spec §1.14).
  if (context.mode !== "human") return { ok: false, error: notHuman(context, "the inbox is a human surface", "a run's worklist is `task list --watcher <your-loop-id> --due`, or `--unwatched` for the pool") };
  const { rows, stamp } = await inboxUnion(context.teamId, now);
  const items = rows.map(({ task, reasons, askedAt }) => ({ task: taskListShape(task), reasons, askedAt }));
  return { ok: true, value: { items, counts: inboxCounts(rows), now: stamp } };
}

export async function verdict(id: string, answer: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  // Double-covered with the route's own human-only gate. The guard is on the
  // PRESENCE of run context, not on a credential class: a request that names a
  // run is by construction an agent's, and the answer belongs to a person
  // (spec §4.2) — including on a task the run's own loop created.
  if (context.mode !== "human") return { ok: false, error: notHuman(context) };
  if (typeof answer !== "string" || !answer.trim()) return { ok: false, error: refusal("INVALID_BODY", "answer must be non-empty text", [{ path: "answer", message: "required" }], "free text — approve, reject and instructions are all just the answer; a reason is what lets the loop converge next time") };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const task = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(task, "task", context.teamId); if (guard) return guard;
    if (task!.status !== "open") return { ok: false, error: refusal("CLOSED", `${id} is closed`) };
    if (!task!.pendingQuestion?.trim()) return { ok: false, error: refusal("NO_OPEN_QUESTION", `${id} has no open question`, [], "refresh the inbox; this question may already have been answered") };
    let queuedAlready = false;
    const watcherLoop = task!.watcher ? await store.getObjectForUpdate(tx, task!.watcher) : undefined;
    const updated = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields: { pendingQuestion: null }, note: answer, eventKind: "question-answered" });
    // A kernel refusal is propagated verbatim — flattening it to a generic body
    // error would lose exactly the teaching the refusal exists to carry.
    if (!updated.ok) return { ok: false, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
    if (!updated.event) return { ok: false, error: refusal("INVALID_BODY", "the verdict cleared nothing and recorded no answer", [], "refresh the inbox; this question may already have been answered") };
    let queued: Awaited<ReturnType<typeof queueKernelRun>>["run"] | undefined;
    // R-answer JOINS rather than stacks. The one-queued-run-per-loop index is the
    // queue discipline (spec §6.1), so a second answer for the same watcher does
    // not refuse the human and does not mint a twin: it reports the run already
    // queued, which will pull both answered tasks when it claims. Refusing here
    // would make a person's answer fail for a reason that is not about them.
    if (watcherLoop?.kind === "loop" && watcherLoop.teamId === context.teamId) {
      const q = await queueKernelRun(tx, { loop: watcherLoop, now: now.toISOString(), reason: "answered", scope: `task:${id}`, verdictEventId: updated.event.id });
      queued = q.run;
      if (queued && q.outcome === "queued") {
        await store.appendEvent(tx, { id: derivedEventId({ runId: queued.id, kind: "run-queued" }), teamId: watcherLoop.teamId, objectId: watcherLoop.id, kind: "run-queued", origin: "derived", entrance: "answer", actorId: queued.id, payload: { reason: "answered", scope: `task:${id}` }, ts: now.toISOString() });
      }
      if (queued) queuedAlready = q.outcome === "loop-busy";
    }
    return { ok: true, value: { task: objectShape(updated.object), event: updated.event.id, run: queued ? { id: queued.id, state: queued.queueState, loopId: queued.loopId, scope: queued.scope, reason: queued.reason, entrance: queued.entrance, alreadyQueued: queuedAlready } : null } };
  });
}

export async function eventsAfter(teamId: string, after: number, limit = 200): Promise<KernelEvent[]> {
  return db.select().from(events).where(and(eq(events.teamId, teamId), gt(events.seq, after))).orderBy(asc(events.seq)).limit(limit);
}

export async function eventTail(teamId: string): Promise<number> {
  return (await db.select({ seq: events.seq }).from(events).where(eq(events.teamId, teamId)).orderBy(desc(events.seq)).limit(1))[0]?.seq ?? 0;
}

function scopedKindGuard(row: KernelObject | undefined, kind: ObjectKind, teamId: string): ApiResult<never> | undefined {
  if (!row || row.teamId !== teamId) return { ok: false, error: refusal("NOT_FOUND", "object was not found") };
  if (row.kind !== kind) return { ok: false, error: refusal("WRONG_KIND", `${row.id} is a ${row.kind}, not a ${kind}`) };
}

function kernelUpdateResult(kind: ObjectKind, result: Awaited<ReturnType<typeof applyUpdateIn>>): ApiResult<Record<string, unknown>> {
  if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
  return { ok: true, value: { changed: result.changed, [kind]: objectShape(result.object), event: result.event?.id ?? null, diff: result.event?.diff ?? {} } };
}

function unknownJsonKey(where: string, key: string, allowed: string[]): ApiRefusal { return refusal("UNKNOWN_KEY", `unknown key "${key}" in ${where}`, [{ path: key, message: "unknown key", got: key }], `${where} accepts: ${allowed.join(", ")}`); }
function notHuman(context: ApiContext, message = "this question is waiting for a human", hint?: string): ApiRefusal {
  return refusal("NOT_HUMAN", message, context.run ? [{ path: "X-Loopany-Run", message: "a request carrying run context is an agent's", got: context.run.id }] : [], hint);
}
function notYourLoop(context: ApiContext, id: string): ApiRefusal { return refusal("NOT_YOUR_LOOP", `${context.run?.id ?? "this run"} belongs to ${context.run?.loopId ?? "another loop"} and may not write ${id}`, [{ path: "id", message: "must be the run's own loop", got: id, expected: context.run?.loopId ?? "" }], "a run evolves and governs only its own loop") }
function mergePayload(before: Record<string, unknown> | null, patch: Record<string, unknown>) { const out = { ...(before ?? {}) }; for (const [key, value] of Object.entries(patch)) if (value === null) delete out[key]; else out[key] = value; return out; }
export function taskListShape(row: KernelObject): Record<string, unknown> { return { id: row.id, kind: row.kind, status: row.status, title: row.title, followUpAt: row.followUpAt, pendingQuestion: row.pendingQuestion, watcher: row.watcher, key: row.key, createdByLoop: row.createdByLoop, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
export function loopListShape(row: KernelObject): Record<string, unknown> { return { id: row.id, kind: row.kind, status: row.status, title: row.title, cron: row.cron, timezone: row.timezone, nextFire: row.nextFire, workdir: row.workdir, key: row.key, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
export function eventShape(row: KernelEvent) { return { id: row.id, seq: row.seq, objectId: row.objectId, kind: row.kind, entrance: row.entrance, actor: row.actorId, transition: row.transition, diff: row.diff, note: row.note, ts: row.ts }; }
function lookbackDate(value: string, now: Date): string | undefined { const m = /^(\d+)(h|d)$/.exec(value); if (m) return new Date(now.getTime() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000)).toISOString(); return parseDate(value, now); }
function reasonRank(reasons: string[]) { return reasons.includes("question") ? 0 : reasons.includes("due-unwatched") ? 1 : 2; }
