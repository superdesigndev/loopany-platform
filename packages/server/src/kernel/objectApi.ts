import { and, asc, count, desc, eq, gt, isNotNull, lte, ne, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { events, objects, type KernelEvent, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import { loops as productionLoops, runs, type Loop } from "../db/schema.js";
import { appendOrganicEvent, applyTransitionIn, applyUpdateIn, buildFieldDiff, createObjectIn, sameValue, type WritableFields } from "./applyTransition.js";
import { MIRRORS_KEY, MIRRORS_UPDATE_HINT, parseDate, parseKindArtifact, serializeKindArtifact, type ArtifactProjection } from "./artifactSeam.js";
import { derivedEventId } from "./ids.js";
import { attachMirrorIn, mirrorsFor } from "./mirrorApi.js";
import {
  appendDerivedEvent,
  notifyProductionRunQueued,
  queueKernelRun,
  queueLoopTeamId,
  resolveQueueLoopIn,
} from "./runQueue.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import type { ApiContext } from "./apiAuth.js";
import { isArtifactKind, type ArtifactKind, type EventDiff, type ObjectKind } from "./types.js";

export type ApiResult<T> = { ok: true; status?: number; value: T } | { ok: false; error: ApiRefusal };

export function objectShape(row: KernelObject): Record<string, unknown> {
  const common = { id: row.id, kind: row.kind, team: row.teamId, status: row.status, title: row.title, key: row.key, payload: row.payload ?? {}, body: row.body ?? "", createdByRun: row.createdByRun, createdByLoop: row.createdByLoop, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (row.kind === "task") return { ...common, followUpAt: row.followUpAt, pendingQuestion: row.pendingQuestion, watcher: row.watcher, parentId: row.parentId, closedAt: row.closedAt };
  if (row.kind === "doc") return { ...common, format: row.format ?? "markdown" };
  // A MIRROR drops `payload` and `body` from the common shape rather than
  // echoing the empty defaults: the fields do not exist on the row (the DDL
  // forbids them), so printing `payload: {}` would advertise a free zone this
  // kind deliberately has not got.
  const { payload: _p, body: _b, title, ...rest } = common;
  return { ...rest, externalKind: row.mirrorKind, coords: row.mirrorCoords, note: title, attachedTo: row.attachedTo ?? [] };
}

export async function createFromArtifact(kind: ArtifactKind, raw: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const parsed = parseKindArtifact(kind, raw, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const p = parsed.value;
  const result = await createObjectInTransaction({ kind, p, context, now });
  if (!result.ok) return { ok: false, error: refusal(result.code as never, result.message, result.issues, result.hint) };
  const differingFields = result.created ? [] : expressedDiffs(result.object, p, kind);
  const name = kind;
  return { ok: true, status: result.created ? 201 : 200, value: {
    created: result.created, ...(result.created ? {} : { contentDiffers: differingFields.length > 0, differingFields }),
    // An idempotent hit writes nothing, so it reports no event — the caller must
    // be able to tell a fresh effect from a replay (spec §1.4).
    [name]: objectShape(result.object), event: result.created ? result.event?.id ?? null : null,
    // The `mirrors:` block, resolved. Echoed even when empty so a caller can see
    // that a block it wrote was read (and that a file with none has none).
    mirrors: result.mirrors,
    ...(!result.created && differingFields.length ? { notice: { code: "KEY_EXISTS_CONTENT_DIFFERS", message: `key "${p.key}" already names ${result.object.id}; the submitted file differs from it and was not applied`, hint: `to change it: PATCH /api/${name}s/${result.object.id} with the same file` } } : {}),
  } };
}

/**
 * The object AND its inline `mirrors:` block, in ONE transaction.
 *
 * "The file IS the object" is the create contract, and a `mirrors:` block is
 * part of the file, so a task that declares a PR is never briefly a task that
 * does not: either both land or neither does. A REPLAY re-asserts the same
 * attachments, which is a no-op by construction (attach is idempotent on the
 * attachment set), so a retried create still converges.
 */
async function createObjectInTransaction(input: { kind: ArtifactKind; p: ReturnType<typeof projection>; context: ApiContext; now: Date }) {
  const { kind, p, context, now } = input;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const created = await createObjectIn(tx, {
      teamId: context.teamId, kind, actor: context.actor, now: now.toISOString(), key: p.key,
      title: p.title, body: p.body, payload: p.payload,
      ...(kind === "task" ? { followUpAt: p.followUpAt, pendingQuestion: p.pendingQuestion, watcher: p.watcher, parentId: p.parentId } : {}),
      ...(kind === "doc" ? { format: p.format } : {}),
      createdByRun: context.run?.id ?? null, createdByLoop: context.run?.loopId ?? null,
    });
    if (!created.ok) return created;
    const mirrors: unknown[] = [];
    for (const spec of p.mirrors ?? []) {
      const attached = await attachMirrorIn(tx, spec, created.object, context, now);
      // A bad pointer FAILS THE CREATE. The block is part of the file, and a
      // half-applied file is exactly the ambiguity the one-transaction rule
      // exists to prevent — the refusal is propagated verbatim so the author
      // sees which entry was wrong, not a generic create failure.
      if (!attached.ok) return { ok: false as const, code: attached.error.code, message: attached.error.message, issues: attached.error.issues, hint: attached.error.hint };
      mirrors.push((attached.value as { mirror: unknown }).mirror);
    }
    return { ...created, mirrors };
  });
}

function projection(p: ArtifactProjection) { return p; }

function expressedDiffs(row: KernelObject, p: ArtifactProjection, kind: ArtifactKind): string[] {
  const pairs: [string, unknown, unknown][] = [["title", row.title, p.title], ["body", row.body ?? "", p.body], ["payload", row.payload ?? null, p.payload]];
  if (kind === "task") pairs.push(["followUpAt", row.followUpAt, p.followUpAt], ["watcher", row.watcher, p.watcher], ["parentId", row.parentId, p.parentId], ["pendingQuestion", row.pendingQuestion, p.pendingQuestion]);
  if (kind === "doc") pairs.push(["format", row.format ?? "markdown", p.format]);
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
  // `watcher=none` (the CLI's `--unwatched`) retired with the pool it queried:
  // every task names a watcher now, so the predicate could only ever be empty.
  const watcher = query.get("watcher");
  if (watcher) { if (!watcher.startsWith("loop-")) return { ok: false, error: refusal("SCHEMA_VIOLATION", "watcher must be an explicit loop id", [{ path: "watcher", message: "must start with loop-", got: watcher, expected: "loop-<id>" }], "there is no self keyword and no unwatched pool; use the loop id from the work order") }; conds.push(eq(objects.watcher, watcher)); }
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
  // THE REVERSE LOOKUP. A task does not carry its mirrors — it is FOUND BY them
  // — so every `show` composes the set here rather than reading a column. This
  // is the read the whole kind exists for: "what outside this system does this
  // depend on, and where do I go to check it?"
  const value: Record<string, unknown> = { [kind]: objectShape(row), events: history.map(eventShape), mirrors: await mirrorsFor(undefined, context.teamId, id) };
  if (kind === "task") {
    value.runs = await db.select({ id: runs.id, phase: runs.phase, scope: runs.scope, reason: runs.reason, ts: runs.ts, durationMs: runs.durationMs }).from(runs).where(or(eq(runs.scope, `task:${id}`), eq(runs.id, row.createdByRun ?? ""))).orderBy(desc(runs.ts));
    // BOTH DIRECTIONS of the hierarchy, because a run reading one task has to be
    // able to walk it: `parent` is on the row itself (a column), `children` is
    // the reverse lookup nothing else would give it. A missing parent row is
    // reported as such rather than omitted — the write guard refuses a dangling
    // reference, so one that exists is a fact worth seeing, not a blank.
    value.children = (await db.select().from(objects).where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "task"), eq(objects.parentId, id))).orderBy(asc(objects.createdAt))).map(taskListShape);
    if (row.parentId) {
      const parent = await store.getObject(undefined, row.parentId);
      value.parent = parent && parent.teamId === context.teamId ? taskListShape(parent) : { id: row.parentId, missing: true };
    }
  }
  return { ok: true, value };
}

export function objectArtifact(row: KernelObject): string {
  if (!isArtifactKind(row.kind)) throw new Error(`${row.kind} is not authored as a file`);
  return serializeKindArtifact(row.kind, { title: row.title, key: row.key, body: row.body ?? "", payload: row.payload, followUpAt: row.followUpAt, watcher: row.watcher, parentId: row.parentId, pendingQuestion: row.pendingQuestion, format: (row.format ?? "markdown") as "markdown" | "html" });
}

export async function replaceFromArtifact(kind: ArtifactKind, id: string, raw: string, context: ApiContext, now = new Date(), eventKind?: string): Promise<ApiResult<Record<string, unknown>>> {
  const parsed = parseKindArtifact(kind, raw, now); if (!parsed.ok) return parsed;
  // `mirrors:` IS CREATE-ONLY (artifactSeam `MIRRORS_KEY`). Accepting it here
  // would make a whole-file update the authority on a set that lives on the
  // mirror side — so a file that simply omitted one would silently detach it.
  // Refused by name rather than ignored: silent discard is forbidden.
  if (parsed.value.mirrors?.length) {
    return { ok: false, error: refusal("UNKNOWN_KEY", `${MIRRORS_KEY}: is accepted only when the object is created`, [{ path: MIRRORS_KEY, message: "create-only", got: `${parsed.value.mirrors.length} entries` }], MIRRORS_UPDATE_HINT) };
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const before = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(before, kind, context.teamId); if (guard) return guard;
    if (parsed.value.key !== null && parsed.value.key !== before!.key) return { ok: false, error: refusal("IMMUTABLE_KEY", "key cannot be changed", [{ path: "key", message: "fixed at creation", got: parsed.value.key, expected: before!.key ?? "(remove the key)" }], "restore the stored key or remove the line") };
    if (context.mode === "agent" && kind === "task" && before!.pendingQuestion && parsed.value.pendingQuestion !== before!.pendingQuestion) return { ok: false, error: refusal("NOT_HUMAN", "a run cannot clear or replace a pending question", [], "a human answers or withdraws it") };
    const fields: WritableFields = { title: parsed.value.title, body: parsed.value.body, payload: parsed.value.payload };
    if (kind === "task") Object.assign(fields, { followUpAt: parsed.value.followUpAt, watcher: parsed.value.watcher, parentId: parsed.value.parentId, pendingQuestion: parsed.value.pendingQuestion });
    if (kind === "doc") fields.format = parsed.value.format;
    const result = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields, eventKind: eventKind ?? "object-updated" });
    return kernelUpdateResult(kind, result);
  });
}

export async function patchTask(id: string, body: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const allowed = ["followUp", "watcher", "parent", "needsHuman", "title", "payloadMerge", "body"];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: refusal("INVALID_BODY", "task patch must be a JSON object") };
  const rec = body as Record<string, unknown>; const unknown = Object.keys(rec).find((k) => !allowed.includes(k));
  if (unknown) return { ok: false, error: unknownJsonKey("task patch", unknown, allowed) };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const before = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(before, "task", context.teamId); if (guard) return guard;
    const fields: WritableFields = {};
    if (Object.hasOwn(rec, "followUp")) { if (rec.followUp === null) fields.followUpAt = null; else if (typeof rec.followUp === "string") { const d = parseDate(rec.followUp, now); if (!d) return { ok: false, error: refusal("BAD_DATE", "followUp is not a date this server accepts") }; fields.followUpAt = d; } else return { ok: false, error: refusal("SCHEMA_VIOLATION", "followUp must be a string or null") }; }
    // TRANSFER ONLY. `watcher: null` used to release a task back to the
    // unclaimed pool; there is no pool any more, so a null here is the release
    // gesture arriving at a surface that no longer has one — refused by name
    // rather than silently coerced (captain ruling 2026-08-04, types.ts).
    if (Object.hasOwn(rec, "watcher")) { if (typeof rec.watcher !== "string" || !rec.watcher.startsWith("loop-")) return { ok: false, error: refusal("WATCHER_REQUIRED", "watcher must name the loop that acts next", [{ path: "watcher", message: "must be a loop id", got: rec.watcher === null ? "null" : JSON.stringify(rec.watcher), expected: "loop-<id>" }], "a watcher is TRANSFERRED to another loop, never cleared — `loopany loops` prints the ids") }; fields.watcher = rec.watcher; }
    // MOVE, or MOVE TO ROOT. `parent: null` is a legal write — a task genuinely
    // can stop being a sub-task — which is the one place hierarchy and the
    // watcher rule differ: a watcher is transferred and never cleared, a parent
    // may be cleared and there is no roll-up either way. Reality (exists, is a
    // task, same team, not inside its own subtree) is the kernel's call at the
    // write chokepoint; only the SHAPE is decided here.
    if (Object.hasOwn(rec, "parent")) {
      if (rec.parent !== null && (typeof rec.parent !== "string" || !rec.parent.startsWith("task-"))) {
        return { ok: false, error: refusal("SCHEMA_VIOLATION", "parent must name a task, or be null to make this task a root", [{ path: "parent", message: "must be a task id or null", got: rec.parent === null ? "null" : JSON.stringify(rec.parent), expected: "task-<id>" }], "hierarchy is a TASK relation and the reference is by id: `loopany task list` prints them. The loop that acts next is the watcher, not the parent.") };
      }
      fields.parentId = rec.parent as string | null;
    }
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

/**
 * `POST /api/loops/:id/run-now` — the MANUAL fire (API spec §1.16).
 *
 * HUMAN-ONLY, like the lifecycle verbs: firing a loop off-cadence is an
 * operational act the owner keeps, and a run that could wake itself would be a
 * loop with no cadence at all. It reuses `queueKernelRun`'s `manual` reason, so
 * a manual run is claimed, leased, reported and retried by exactly the machinery
 * a clock fire uses — the only difference is the entrance recorded on the event.
 *
 * The transactional pending-run lookup is the queue discipline, and a manual
 * fire joins work that has not claimed yet. Once a run is executing its delivery
 * is immutable, so a later manual fire queues behind it and the claim guard
 * prevents overlap.
 *
 * **A PAUSED production loop accepts a manual fire** (captain ruling
 * 2026-08-04). Pause governs the CADENCE (`enabled=false`), and a manual fire
 * is an explicit human act, not the clock. Refusing it
 * conflated the two and made the only way to run a parked loop once a
 * resume/fire/pause dance that leaves a real window in which the cadence is live.
 * Firing does NOT resume: `enabled` stays false, the status stays `paused`,
 * and the loop is quiet again the moment the run finishes.
 */
export async function runLoopNow(id: string, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  if (context.mode !== "human") {
    return { ok: false, error: notHuman(context, "firing a loop off its cadence is the owner's act", `propose it: \`loopany task create --file <path> --needs-human "run this loop now because …" --watcher ${context.run?.loopId ?? "<your-loop-id>"}\``) };
  }
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const loop = await resolveQueueLoopIn(tx, context.teamId, id);
    if (!loop) return { ok: false as const, error: refusal("NOT_FOUND", "object was not found") };
    if (loop.nextRunAt) {
      await tx.update(productionLoops).set({ nextRunAt: null }).where(eq(productionLoops.id, loop.id));
    }
    const queued = await queueKernelRun(tx, { loop, now: now.toISOString(), reason: "manual" });
    if (queued.outcome === "queued") {
      await appendOrganicEvent(tx, {
        teamId: queueLoopTeamId(loop),
        objectId: loop.id,
        kind: "run-queued",
        origin: "organic",
        entrance: "human",
        actorId: context.actor.actorId,
        payload: { runId: queued.run!.id, reason: "manual" },
        ts: now.toISOString(),
      });
    }
    return { ok: true as const, value: { queued: queued.outcome === "queued", alreadyQueued: queued.outcome === "loop-busy", run: queued.run ? { id: queued.run.id, state: runQueueState(queued.run), reason: queued.run.reason } : null, loop: queueLoopShape(loop) } };
  });
  // Wake any daemon parked on the claim long-poll: without this the manual fire
  // waits out the hold (~20s) for no reason.
  await wakeQueuedResult(result);
  return result;
}

/** One inbox row before it is shaped for a consumer: the task row, why it is
 *  here, and when the question was asked (plus by whom). */
export interface InboxUnionRow {
  task: KernelObject;
  reasons: string[];
  askedAt: string | null;
  askedByRun: string | null;
}

/**
 * THE §6 SAFETY FLOOR, single-sourced. Both the raw `GET /api/inbox` (the human
 * CLI's surface) and the composed `GET /api/views/inbox` (the screen's) read it,
 * so the floor cannot mean two different things depending on which one you are
 * looking at. It returns ROWS, not a payload shape — each caller shapes.
 *
 * IT IS NOW ONE BRANCH: an open task with a question waiting for a human.
 *
 * It used to be three. The other two — a due task nobody watched, and the
 * 48-hour orphan floor for a task with neither watcher nor follow-up — were both
 * predicated on `watcher IS NULL`, and the watcher rule (types.ts `WATCHER_HINT`)
 * removed that state from the system. They are not "disabled": their queries can
 * no longer match a row, and keeping them would be two permanently-zero counters
 * teaching a distinction the kernel no longer draws. What they used to catch is
 * now caught earlier and better — a task always has a loop on the hook, and a
 * due one WAKES that loop (`tickDueTasks`) instead of waiting to be noticed.
 *
 * The union shape (`reasons` as an array, `reasonRank`) is deliberately kept:
 * it costs nothing, and the inbox is exactly where a future human-attention
 * branch would land.
 */
export async function inboxUnion(teamId: string, now: Date): Promise<{ rows: InboxUnionRow[]; stamp: string }> {
  const stamp = now.toISOString();
  const rows = await db.select().from(objects).where(and(eq(objects.teamId, teamId), eq(objects.kind, "task"), eq(objects.status, "open"), isNotNull(objects.pendingQuestion), ne(objects.pendingQuestion, ""))).orderBy(asc(objects.createdAt));
  const withReasons = await Promise.all(rows.map(async (task): Promise<InboxUnionRow> => {
    const hs = await store.listObjectEvents(undefined, task.id);
    const asked = [...hs].reverse().find((e) => e.diff?.pendingQuestion?.new === task.pendingQuestion);
    return { task, reasons: ["question"], askedAt: asked?.ts ?? task.updatedAt, askedByRun: asked?.entrance === "agent" ? asked.actorId : null };
  }));
  withReasons.sort((a, b) => reasonRank(a.reasons) - reasonRank(b.reasons) || a.task.createdAt.localeCompare(b.task.createdAt));
  return { rows: withReasons, stamp };
}

/** The floor's branch count plus the total — the badge every inbox surface
 *  shows. One branch today, so the two agree; both are kept because every
 *  consumer renders "N waiting" beside "why", and a future branch adds a key
 *  here rather than a second shape. */
export function inboxCounts(rows: InboxUnionRow[]) {
  const n = (r: string) => rows.filter((i) => i.reasons.includes(r)).length;
  return { question: n("question"), total: rows.length };
}

export async function inbox(context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  // The inbox routes HUMAN attention. An agent learns nothing here that
  // `task list` does not already give it (spec §1.14).
  if (context.mode !== "human") return { ok: false, error: notHuman(context, "the inbox is a human surface", "a run's worklist is `task list --watcher <your-loop-id> --due`") };
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
  const result: ApiResult<Record<string, unknown>> = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec; const task = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(task, "task", context.teamId); if (guard) return guard;
    if (task!.status !== "open") return { ok: false, error: refusal("CLOSED", `${id} is closed`) };
    if (!task!.pendingQuestion?.trim()) return { ok: false, error: refusal("NO_OPEN_QUESTION", `${id} has no open question`, [], "refresh the inbox; this question may already have been answered") };
    let queuedAlready = false;
    const watcherLoop = task!.watcher ? await resolveQueueLoopIn(tx, context.teamId, task!.watcher) : undefined;
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
    if (watcherLoop) {
      const q = await queueKernelRun(tx, { loop: watcherLoop, now: now.toISOString(), reason: "answered", scope: `task:${id}`, verdictEventId: updated.event.id });
      queued = q.run;
      if (queued && q.outcome === "queued") {
        await appendDerivedEvent(tx, { id: derivedEventId({ runId: queued.id, kind: "run-queued" }), teamId: queueLoopTeamId(watcherLoop), objectId: watcherLoop.id, kind: "run-queued", origin: "derived", entrance: "answer", actorId: queued.id, payload: { reason: "answered", scope: `task:${id}` }, ts: now.toISOString() });
      }
      if (queued) queuedAlready = q.outcome === "loop-busy";
    }
    return { ok: true as const, value: { task: objectShape(updated.object), event: updated.event.id, run: queued ? { id: queued.id, state: runQueueState(queued), loopId: queued.loopId, scope: queued.scope, reason: queued.reason, entrance: queued.entrance, alreadyQueued: queuedAlready } : null } };
  });
  await wakeQueuedResult(result);
  return result;
}

/**
 * `POST /api/tasks/:id/directive` — THE HUMAN SPEAKS FIRST.
 *
 * The inbox is an AGENT-initiated conversation: a run asks, a person answers.
 * This is the other direction — a person tells the watching loop something about
 * a task it holds, without having been asked, and the loop wakes to act on it.
 * Same wire as the answer path, opposite entrance.
 *
 * FOUR rulings are worth keeping:
 *
 *  1. **It is its own run reason (`directive`), not a flavour of `answered`.**
 *     An answer replies to a question the agent framed; a directive arrives
 *     unframed and the run's first job is to work out what it implies against
 *     external reality. A run that could not tell them apart would read the
 *     directive as an answer to a question it never asked. `types.ts`
 *     RUN_REASONS carries the reasoning.
 *  2. **A pending question REFUSES it.** With a question open the person already
 *     has the floor and the wire for it, and the run this would queue could not
 *     clear the question anyway. Two open conversations on one task is precisely
 *     the ambiguity keeping the verbs distinct is meant to avoid.
 *  3. **It OBEYS the transactional open-run join, exactly as a verdict does.** A
 *     directive on a loop that already has a run queued REPORTS that run rather
 *     than stacking a twin — the directive is on the task's timeline either way,
 *     so the queued run reads it when it claims.
 *  4. **The run carries the words VERBATIM.** `triggerEventId` points at the
 *     directive event, and `claimRun` reads the note through it into the work
 *     order — the agent is told what it was asked, not merely that something
 *     changed.
 */
export async function leaveDirective(id: string, directive: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  // Human-only, on the same positive test for run context the verdict uses: a
  // request naming a run is an agent's, and a loop instructing itself is a loop
  // with no cadence at all.
  if (context.mode !== "human") {
    return { ok: false, error: notHuman(context, "a directive is a person telling a loop what to do, so it is entered by a person", "a run that wants another loop to act files a task for it: `loopany task create --file <path> --watcher <that-loop-id>`") };
  }
  if (typeof directive !== "string" || !directive.trim()) {
    return { ok: false, error: refusal("INVALID_BODY", "a directive is non-empty text", [{ path: "directive", message: "required" }], "say what you want done and why — the run executes the INTENT against reality, so \"drop this bet\" means close the PR and clean up, not just close the task") };
  }
  const text = directive.trim();
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const task = await store.getObjectForUpdate(tx, id);
    const guard = scopedKindGuard(task, "task", context.teamId); if (guard) return guard;
    if (task!.status !== "open") {
      return { ok: false as const, error: refusal("CLOSED", `${id} is closed, and a closed task is a record`, [{ path: "status", message: "closed", got: task!.status }], "closed is terminal and there is no reopen — file a new task for the follow-on work, or fire the loop directly with Run now on its loop page") };
    }
    if (task!.pendingQuestion?.trim()) {
      return { ok: false as const, error: refusal("OPEN_QUESTION", `${id} is already waiting on you for an answer`, [{ path: "pendingQuestion", message: "a question is open on this task", got: task!.pendingQuestion }], `answer it instead — \`loopany answer ${id} "…"\` records your reply AND wakes the watcher, and the answer is free text, so any instruction fits in it`) };
    }
    const watcherLoop = task!.watcher ? await resolveQueueLoopIn(tx, context.teamId, task!.watcher) : undefined;

    // The directive lands on the TASK's timeline: it is a fact about this task,
    // entered by a human, and it stays readable there whether or not a run was
    // queued for it. Organic — two directives a week apart are two real facts.
    const event = await appendOrganicEvent(tx, {
      teamId: task!.teamId, objectId: task!.id, kind: "directive-left", origin: "organic",
      entrance: "human", actorId: context.actor.actorId, note: text,
      payload: { watcher: task!.watcher }, ts: now.toISOString(),
    });

    let queued: Awaited<ReturnType<typeof queueKernelRun>>["run"] | undefined;
    let alreadyQueued = false;
    if (watcherLoop) {
      const q = await queueKernelRun(tx, { loop: watcherLoop, now: now.toISOString(), reason: "directive", scope: `task:${id}`, triggerEventId: event.id });
      queued = q.run;
      alreadyQueued = q.outcome === "loop-busy";
      if (queued && q.outcome === "queued") {
        await appendDerivedEvent(tx, { id: derivedEventId({ runId: queued.id, kind: "run-queued" }), teamId: queueLoopTeamId(watcherLoop), objectId: watcherLoop.id, kind: "run-queued", origin: "derived", entrance: "human", actorId: queued.id, payload: { reason: "directive", scope: `task:${id}`, directive: event.id }, ts: now.toISOString() });
      }
    }
    return { ok: true as const, value: {
      task: objectShape(task!), event: event.id, directive: text,
      run: queued ? { id: queued.id, state: runQueueState(queued), loopId: queued.loopId, scope: queued.scope, reason: queued.reason, entrance: queued.entrance, alreadyQueued } : null,
    } };
  });
  // Wake a daemon parked on the claim long-poll rather than making the person
  // wait out the ~20s hold for a run they just asked for.
  await wakeQueuedResult(result);
  return result;
}

function runQueueState(run: { phase: string }): string {
  return run.phase === "pending" ? "queued" : run.phase;
}

/** A PRODUCTION loop, in the shape the run-now response renders. */
function queueLoopShape(loop: Loop): Record<string, unknown> {
  return {
    id: loop.id,
    kind: "loop",
    team: loop.teamId,
    status: loop.completedAt ? "completed" : loop.enabled ? "active" : "paused",
    title: loop.name,
    cron: loop.cron,
    enabled: loop.enabled,
  };
}

/** Wake the correct claim transport only for a freshly queued row. The event
 * transaction has committed by the time this runs, so a woken poll can always
 * see the durable pending row. */
async function wakeQueuedResult(result: ApiResult<Record<string, unknown>>): Promise<void> {
  if (!result.ok || result.value.queued === false) return;
  const runShape = result.value.run as { id?: unknown; alreadyQueued?: unknown } | null | undefined;
  if (!runShape || runShape.alreadyQueued === true || typeof runShape.id !== "string") return;
  const run = await store.getRunRow(undefined, runShape.id);
  if (!run) return;
  await notifyProductionRunQueued(run);
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
function mergePayload(before: Record<string, unknown> | null, patch: Record<string, unknown>) { const out = { ...(before ?? {}) }; for (const [key, value] of Object.entries(patch)) if (value === null) delete out[key]; else out[key] = value; return out; }
export function taskListShape(row: KernelObject): Record<string, unknown> { return { id: row.id, kind: row.kind, status: row.status, title: row.title, followUpAt: row.followUpAt, pendingQuestion: row.pendingQuestion, watcher: row.watcher, parentId: row.parentId, key: row.key, createdByLoop: row.createdByLoop, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
export function eventShape(row: KernelEvent) { return { id: row.id, seq: row.seq, objectId: row.objectId, kind: row.kind, entrance: row.entrance, actor: row.actorId, transition: row.transition, diff: row.diff, note: row.note, ts: row.ts }; }
function lookbackDate(value: string, now: Date): string | undefined { const m = /^(\d+)(h|d)$/.exec(value); if (m) return new Date(now.getTime() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000)).toISOString(); return parseDate(value, now); }
function reasonRank(reasons: string[]) { return reasons.includes("question") ? 0 : 1; }
