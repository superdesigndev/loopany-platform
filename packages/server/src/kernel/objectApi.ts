import { and, asc, count, desc, eq, gt, isNotNull, isNull, lte, ne, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { events, objects, type KernelEvent, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import { runs } from "../db/schema.js";
import { applyTransitionIn, applyUpdateIn, buildFieldDiff, createObjectIn, sameValue, type WritableFields } from "./applyTransition.js";
import { parseDate, parseKindArtifact, serializeKindArtifact, type ArtifactProjection } from "./artifactSeam.js";
import { derivedEventId, organicEventId, msOf } from "./ids.js";
import { queueKernelRun } from "./runQueue.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import { nextOccurrenceAfter } from "./schedule.js";
import type { ApiContext } from "./apiAuth.js";
import type { EventDiff, ObjectKind } from "./types.js";

export type ApiResult<T> = { ok: true; status?: number; value: T } | { ok: false; error: ApiRefusal };

export function objectShape(row: KernelObject): Record<string, unknown> {
  const common = { id: row.id, kind: row.kind, team: row.teamId, status: row.status, title: row.title, key: row.key, payload: row.payload ?? {}, body: row.body ?? "", createdByRun: row.createdByRun, createdByLoop: row.createdByLoop, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (row.kind === "task") return { ...common, followUpAt: row.followUpAt, pendingQuestion: row.pendingQuestion, watcher: row.watcher, closedAt: row.closedAt };
  if (row.kind === "doc") return { ...common, format: row.format ?? "markdown" };
  return { ...common, cron: row.cron, timezone: row.timezone, nextFire: row.nextFire };
}

export async function createFromArtifact(kind: ObjectKind, raw: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const parsed = parseKindArtifact(kind, raw, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const p = parsed.value;
  const result = await createObjectInTransaction({ kind, p, context, now });
  if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
  const differingFields = result.created ? [] : expressedDiffs(result.object, p, kind);
  const name = kind === "task" ? "task" : kind === "doc" ? "doc" : "loop";
  return { ok: true, status: result.created ? 201 : 200, value: {
    created: result.created, ...(result.created ? {} : { contentDiffers: differingFields.length > 0, differingFields }),
    // An idempotent hit writes nothing, so it reports no event — the caller must
    // be able to tell a fresh effect from a replay (spec §1.4).
    [name]: objectShape(result.object), event: result.created ? result.event?.id ?? null : null,
    ...(!result.created && differingFields.length ? { notice: { code: "KEY_EXISTS_CONTENT_DIFFERS", message: `key "${p.key}" already names ${result.object.id}; the submitted file differs from it and was not applied`, hint: `to change it: PATCH /api/${name}s/${result.object.id} with the same file` } } : {}),
  } };
}

async function createObjectInTransaction(input: { kind: ObjectKind; p: ReturnType<typeof projection>; context: ApiContext; now: Date }) {
  const { kind, p, context, now } = input;
  return db.transaction((tx) => createObjectIn(tx as unknown as store.KernelExec, {
    teamId: context.teamId, kind, actor: context.actor, now: now.toISOString(), key: p.key,
    title: p.title, body: p.body, payload: p.payload,
    ...(kind === "task" ? { followUpAt: p.followUpAt, pendingQuestion: p.pendingQuestion, watcher: p.watcher } : {}),
    ...(kind === "doc" ? { format: p.format } : {}),
    ...(kind === "loop" ? { cron: p.cron } : {}),
    createdByRun: context.run?.id ?? null, createdByLoop: context.run?.loopId ?? null,
  }));
}

function projection(p: ArtifactProjection) { return p; }

function expressedDiffs(row: KernelObject, p: ArtifactProjection, kind: ObjectKind): string[] {
  const pairs: [string, unknown, unknown][] = [["title", row.title, p.title], ["body", row.body ?? "", p.body], ["payload", row.payload ?? null, p.payload]];
  if (kind === "task") pairs.push(["followUpAt", row.followUpAt, p.followUpAt], ["watcher", row.watcher, p.watcher], ["pendingQuestion", row.pendingQuestion, p.pendingQuestion]);
  if (kind === "doc") pairs.push(["format", row.format ?? "markdown", p.format]);
  if (kind === "loop") pairs.push(["cron", row.cron, p.cron]);
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
  return serializeKindArtifact(row.kind, { title: row.title, key: row.key, body: row.body ?? "", payload: row.payload, followUpAt: row.followUpAt, watcher: row.watcher, pendingQuestion: row.pendingQuestion, format: (row.format ?? "markdown") as "markdown" | "html", cron: row.cron });
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
  const allowed = ["cron", "approval"]; if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: refusal("INVALID_BODY", "loop update requires a JSON object") };
  const rec = body as Record<string, unknown>; const unknown = Object.keys(rec).find((k) => !allowed.includes(k)); if (unknown) return { ok: false, error: unknownJsonKey("loop update", unknown, allowed) };
  if (typeof rec.cron !== "string") return { ok: false, error: refusal("INVALID_BODY", "cron is required") };
  const cron = rec.cron;
  if (typeof rec.approval !== "string") return { ok: false, error: refusal("APPROVAL_REQUIRED", "changing this loop's cadence requires an approval key", [{ path: "approval", message: "is required", expected: "ev-<id> of a human answer" }]) };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const loop = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(loop, "loop", context.teamId); if (guard) return guard;
    if (loop!.status === "retired") return { ok: false, error: refusal("RETIRED", `${id} is retired`) };
    const approval = await store.getEvent(tx, rec.approval as string);
    if (!approval || approval.teamId !== loop!.teamId) return { ok: false, error: refusal("APPROVAL_UNKNOWN", `${rec.approval} is not an approval event in this team`) };
    if (approval.entrance !== "human") return { ok: false, error: refusal("APPROVAL_NOT_HUMAN", `${approval.id} was not entered by a human`, [{ path: "approval", message: "entrance must be human", got: approval.entrance, expected: "human" }]) };
    const task = approval.objectId ? await store.getObject(tx, approval.objectId) : undefined;
    if (!task || task.teamId !== loop!.teamId || task.kind !== "task" || task.createdByLoop !== id) return { ok: false, error: refusal("APPROVAL_FOREIGN", `${approval.id} hangs on a task this loop did not create`, [{ path: "approval", message: "the approving task must have been created by this loop", got: task?.createdByLoop ?? "none", expected: id }]) };
    let computedNextFire: string; try { computedNextFire = nextOccurrenceAfter(cron, loop!.timezone, now); } catch { return { ok: false, error: refusal("BAD_CRON", `cron "${cron}" is not valid in this loop's timezone`) }; }
    const nextFire = loop!.status === "active" ? computedNextFire : null;
    const approvalBlock = { event: approval.id, entrance: approval.entrance, actor: approval.actorId, task: task.id, ts: approval.ts };
    const result = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields: { cron, nextFire }, eventKind: "loop-updated", eventPayload: { approval: approvalBlock } });
    if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
    return { ok: true, value: { changed: result.changed, loop: objectShape(result.object), event: result.event?.id ?? null, diff: result.event?.diff ?? {}, approval: approvalBlock, ...(loop!.status === "paused" ? { notice: { code: "LOOP_STILL_PAUSED", message: "the cadence changed but the loop remains paused", hint: "time never un-pauses a loop — a human resumes it" } } : {}) } };
  });
}

export async function inbox(context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  // The inbox routes HUMAN attention. An agent learns nothing here that
  // `task list` does not already give it (spec §1.14).
  if (context.mode !== "human") return { ok: false, error: notHuman(context, "the inbox is a human surface", "a run's worklist is `task list --watcher <your-loop-id> --due`, or `--unwatched` for the pool") };
  const stamp = now.toISOString(); const orphanBefore = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const rows = await db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.status, "open"), or(and(isNotNull(objects.pendingQuestion), ne(objects.pendingQuestion, "")), and(lte(objects.followUpAt, stamp), isNull(objects.watcher)), and(isNull(objects.watcher), isNull(objects.followUpAt), lte(objects.createdAt, orphanBefore))))).orderBy(asc(objects.createdAt));
  const withReasons = await Promise.all(rows.map(async (task) => {
    const reasons: string[] = []; if (task.pendingQuestion?.trim()) reasons.push("question"); if (!task.watcher && task.followUpAt && task.followUpAt <= stamp) reasons.push("due-unwatched"); if (!task.watcher && !task.followUpAt && task.createdAt < orphanBefore) reasons.push("orphan");
    let askedAt: string | null = null; if (reasons.includes("question")) { const hs = await store.listObjectEvents(undefined, task.id); askedAt = [...hs].reverse().find((e) => e.diff?.pendingQuestion?.new === task.pendingQuestion)?.ts ?? task.updatedAt; }
    return { task: taskListShape(task), reasons, askedAt };
  }));
  withReasons.sort((a, b) => reasonRank(a.reasons) - reasonRank(b.reasons) || String(a.task.createdAt).localeCompare(String(b.task.createdAt)));
  const count = (r: string) => withReasons.filter((i) => i.reasons.includes(r)).length;
  return { ok: true, value: { items: withReasons, counts: { question: count("question"), dueUnwatched: count("due-unwatched"), orphan: count("orphan"), total: withReasons.length }, now: stamp } };
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
function taskListShape(row: KernelObject): Record<string, unknown> { return { id: row.id, kind: row.kind, status: row.status, title: row.title, followUpAt: row.followUpAt, pendingQuestion: row.pendingQuestion, watcher: row.watcher, key: row.key, createdByLoop: row.createdByLoop, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
function eventShape(row: KernelEvent) { return { id: row.id, seq: row.seq, objectId: row.objectId, kind: row.kind, entrance: row.entrance, actor: row.actorId, transition: row.transition, diff: row.diff, note: row.note, ts: row.ts }; }
function lookbackDate(value: string, now: Date): string | undefined { const m = /^(\d+)(h|d)$/.exec(value); if (m) return new Date(now.getTime() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000)).toISOString(); return parseDate(value, now); }
function reasonRank(reasons: string[]) { return reasons.includes("question") ? 0 : reasons.includes("due-unwatched") ? 1 : 2; }
