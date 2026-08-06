/**
 * THE MIRROR VERBS — attach, detach, list, kinds, and the reverse lookup every
 * `show` composes `mirrors[]` from.
 *
 * A mirror is the fourth object kind: a pure pointer to something outside this
 * system, so a run reading a task can see which external items it must go and
 * check. `kernel/mirrors.ts` owns the pure half (the vocabulary, normalization,
 * coords validation, the law); this module owns the transactions.
 *
 * THREE properties shape everything below:
 *
 *  1. **One external thing is ONE mirror.** The id and the key both derive from
 *     `(team, kind, coords)`, so a second attach naming the same coords resolves
 *     to the existing row through the kernel's ordinary key-idempotency (§4.1) —
 *     there is no "find or create" branch here, because `createObjectIn` already
 *     is one.
 *  2. **Association lives on the MIRROR side.** `attached_to` is a set on the
 *     mirror; attach and detach are ordinary `applyUpdateIn` writes of that set,
 *     with the usual `{old,new}` diff, on the MIRROR's timeline. The attached
 *     objects carry nothing — which is what lets one PR be depended on by two
 *     tasks with no second row to keep in step.
 *  3. **There is no status write path, at any altitude.** No verb here takes a
 *     state, no column could hold one, and `MIRROR_FORBIDDEN_FIELDS` plus the
 *     `objects_mirror_stateless` CHECK make the "just cache it this once" commit
 *     unwritable rather than merely discouraged.
 */
import { and, asc, count, eq, ilike, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { objects, type KernelEvent, type KernelObject } from "../db/kernel-schema.js";
import * as store from "../db/kernelStore.js";
import { applyUpdateIn, createObjectIn } from "./applyTransition.js";
import { mirrorObjectId } from "./ids.js";
import {
  MIRROR_ATTACH_HINT,
  MIRROR_KIND_HINT,
  MIRROR_KINDS,
  knownMirrorKind,
  mirrorHref,
  mirrorKey,
  normalizeMirror,
  normalizeMirrorKind,
  type NormalizedMirror,
} from "./mirrors.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import type { ApiContext } from "./apiAuth.js";
import type { ApiResult } from "./objectApi.js";
import { MIRROR_COORDS_IMMUTABLE_HINT, MIRROR_STATELESS_HINT, isArtifactKind, type ObjectKind } from "./types.js";

/** The kinds a mirror may hang on. A mirror never attaches to another MIRROR:
 *  a pointer to a pointer is not a dependency, it is an alias, and the coords
 *  already are the alias. */
const ATTACHABLE_KINDS: readonly ObjectKind[] = ["task", "doc"];

/** The wire shape of a mirror. `href` is resolved SERVER-side (the BFF rule) so
 *  no client re-derives an external URL, and it is null whenever the coords do
 *  not determine one. Note there is no `state`, and there is nowhere to put one. */
export function mirrorShape(row: KernelObject) {
  const kind = row.mirrorKind ?? "";
  const coords = row.mirrorCoords ?? "";
  return {
    id: row.id,
    kind: "mirror" as const,
    externalKind: kind,
    coords,
    note: row.title,
    href: mirrorHref(kind, coords),
    attachedTo: row.attachedTo ?? [],
    createdByRun: row.createdByRun,
    createdByLoop: row.createdByLoop,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type MirrorShape = ReturnType<typeof mirrorShape>;

// ------------------------------------------------------------- reverse lookup

/**
 * THE REVERSE LOOKUP — every mirror attached to `objectId`.
 *
 * This is the whole read side of the feature: a task does not carry its mirrors,
 * it is FOUND BY them, which is what keeps the association single-sided. The
 * containment predicate is backed by `objects_mirror_attached_idx` (GIN).
 */
export async function mirrorsFor(x: store.KernelExec | undefined, teamId: string, objectId: string): Promise<MirrorShape[]> {
  const rows = await (x ?? db)
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.teamId, teamId),
        eq(objects.kind, "mirror"),
        sql`${objects.attachedTo} @> ${JSON.stringify([objectId])}::jsonb`,
      ),
    )
    .orderBy(asc(objects.mirrorKind), asc(objects.mirrorCoords));
  return rows.map(mirrorShape);
}

// -------------------------------------------------------------------- attach

export interface AttachInput {
  objectId?: unknown;
  kind?: unknown;
  coords?: unknown;
  note?: unknown;
}

/**
 * `POST /api/mirrors` — create the mirror and attach it, in ONE transaction.
 *
 * This is the one-liner the common case needs: the reference is born from the
 * agent's own work (it just opened the PR), so it is flag-shaped, not
 * file-shaped. There is no separate "create" verb, because a mirror attached to
 * nothing points from nowhere and would be a row nobody could ever find.
 *
 * DUAL: a run attaches what it just made, and a person attaches what they were
 * already tracking. Neither is governance — a pointer changes nothing.
 */
export async function attachMirror(input: AttachInput, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const objectId = typeof input.objectId === "string" ? input.objectId.trim() : "";
  if (!objectId) {
    return { ok: false, error: refusal("INVALID_BODY", "attach names the object that depends on the external thing", [{ path: "objectId", message: "required", expected: "task-<id>" }], MIRROR_ATTACH_HINT) };
  }
  const normalized = normalizeMirror(input);
  if (!normalized.ok) {
    return { ok: false, error: refusal("SCHEMA_VIOLATION", "this mirror is not a usable pointer", normalized.issues, MIRROR_KIND_HINT) };
  }
  const spec = normalized.value;

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const host = await store.getObject(tx, objectId);
    if (!host || host.teamId !== context.teamId) return { ok: false as const, error: refusal("NOT_FOUND", `${objectId} was not found`) };
    if (host.kind === "doc" && host.docKind === "charter") {
      return { ok: false as const, error: refusal("CHARTER_ONLY", `${objectId} is an attached loop charter and cannot own mirrors`) };
    }
    if (!ATTACHABLE_KINDS.includes(host.kind as ObjectKind)) {
      return { ok: false as const, error: refusal("WRONG_KIND", `${objectId} is a ${host.kind}, and a mirror attaches to a task, a doc or a loop`, [{ path: "objectId", message: "not attachable", got: host.kind, expected: ATTACHABLE_KINDS.join("|") }], "a pointer to a pointer is an alias, not a dependency — attach the mirror to the work item instead") };
    }
    return attachMirrorIn(tx, spec, host, context, now);
  });
}

/**
 * The transactional core, shared by the HTTP verb and the `mirrors:` block a
 * task/doc/loop can carry at creation. Both paths must produce byte-identical
 * rows and events, so there is exactly one of them.
 */
export async function attachMirrorIn(
  tx: store.KernelExec,
  spec: NormalizedMirror,
  host: KernelObject,
  context: ApiContext,
  now: Date,
): Promise<ApiResult<Record<string, unknown>>> {
  const stamp = now.toISOString();
  const created = await createObjectIn(tx, {
    teamId: context.teamId,
    kind: "mirror",
    actor: context.actor,
    now: stamp,
    id: mirrorObjectId(context.teamId, spec.kind, spec.coords),
    key: mirrorKey(spec.kind, spec.coords),
    title: spec.note,
    mirrorKind: spec.kind,
    mirrorCoords: spec.coords,
    attachedTo: [host.id],
    createdByRun: context.run?.id ?? null,
    createdByLoop: context.run?.loopId ?? null,
  });
  if (!created.ok) return { ok: false, error: refusal(created.code as never, created.message, created.issues, created.hint) };

  // A fresh mirror is already attached (the create carried the set). An EXISTING
  // one is the interesting case: the same external thing, a second dependant.
  if (created.created) {
    return { ok: true, status: 201, value: { attached: true, created: true, mirror: mirrorShape(created.object), object: host.id, event: created.event?.id ?? null } };
  }

  const before = created.object.attachedTo ?? [];
  if (before.includes(host.id)) {
    // Idempotent replay — the ordinary outcome of a retried attach. No event,
    // because a no-op is not a fact.
    return { ok: true, value: { attached: true, created: false, changed: false, mirror: mirrorShape(created.object), object: host.id, event: null, ...noteNotice(created.object, spec) } };
  }
  const updated = await applyUpdateIn(tx, {
    objectId: created.object.id,
    actor: context.actor,
    now: stamp,
    fields: { attachedTo: [...before, host.id] },
    eventKind: "mirror-attached",
  });
  if (!updated.ok) return { ok: false, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
  return { ok: true, value: { attached: true, created: false, changed: updated.changed, mirror: mirrorShape(updated.object), object: host.id, event: updated.event?.id ?? null, ...noteNotice(created.object, spec) } };
}

/** Silent discard is forbidden (§4.1). A second attach carrying a DIFFERENT note
 *  keeps the note already on record — the mirror is one shared row — and says so
 *  rather than pretending the new label landed. */
function noteNotice(existing: KernelObject, spec: NormalizedMirror) {
  if (!spec.note || spec.note === existing.title) return {};
  return {
    notice: {
      code: "MIRROR_NOTE_KEPT",
      message: `${existing.id} already labels ${existing.mirrorCoords} as ${JSON.stringify(existing.title ?? "")}; the submitted note was not applied`,
      hint: `one external thing is one mirror, shared by everything that depends on it — change the label for everyone with \`loopany mirror update ${existing.id} --note "…"\``,
    },
  };
}

// -------------------------------------------------------------------- detach

/**
 * `POST /api/mirrors/:id/detach` — this object no longer depends on that thing.
 *
 * `--from` is REQUIRED and explicit. A mirror can be attached to several
 * objects, so a bare "detach" would have to guess which dependency the caller
 * meant, and guessing wrong silently removes somebody else's pointer.
 *
 * Detaching the LAST attachment is legal and leaves the row behind with an empty
 * set. That is deliberate: the kernel is event-sourced, so the mirror and its
 * timeline stay readable, and an empty set is simply "nothing depends on this
 * any more" — a fact, not a state to enforce.
 */
export async function detachMirror(mirrorId: string, objectId: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  const from = typeof objectId === "string" ? objectId.trim() : "";
  if (!from) {
    return { ok: false, error: refusal("INVALID_BODY", "detach names the object that no longer depends on the external thing", [{ path: "from", message: "required", expected: "task-<id>" }], "a mirror can hang on several objects, so the one to release is always named: `loopany mirror detach <mirror-id> --from <object-id>`") };
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const mirror = await store.getObjectForUpdate(tx, mirrorId);
    if (!mirror || mirror.teamId !== context.teamId) return { ok: false as const, error: refusal("NOT_FOUND", `${mirrorId} was not found`) };
    if (mirror.kind !== "mirror") return { ok: false as const, error: refusal("WRONG_KIND", `${mirrorId} is a ${mirror.kind}, not a mirror`) };
    const before = mirror.attachedTo ?? [];
    if (!before.includes(from)) {
      // A SUCCESS with `changed: false`, the same ruling `task close` and the
      // loop lifecycle carry: a retry after a dropped connection must be free.
      return { ok: true as const, value: { detached: true, changed: false, mirror: mirrorShape(mirror), object: from, event: null, notice: { code: "NOT_ATTACHED", message: `${mirrorId} was not attached to ${from}`, hint: "detach is idempotent — nothing was written" } } };
    }
    const next = before.filter((id) => id !== from);
    const updated = await applyUpdateIn(tx, {
      objectId: mirrorId,
      actor: context.actor,
      now: now.toISOString(),
      fields: { attachedTo: next },
      eventKind: "mirror-detached",
    });
    if (!updated.ok) return { ok: false as const, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
    return { ok: true as const, value: { detached: true, changed: updated.changed, mirror: mirrorShape(updated.object), object: from, event: updated.event?.id ?? null, orphaned: next.length === 0 } };
  });
}

// ---------------------------------------------------------------------- reads

export async function listMirrors(context: ApiContext, query: URLSearchParams): Promise<ApiResult<Record<string, unknown>>> {
  const allowed = new Set(["attached-to", "kind", "coords-like", "limit"]);
  const unknown = [...query.keys()].find((key) => !allowed.has(key));
  if (unknown) {
    return { ok: false, error: refusal("UNKNOWN_FILTER", `unknown mirror filter "${unknown}"`, [{ path: unknown, message: "unknown filter", got: unknown }], `accepted filters: ${[...allowed].join(", ")}`) };
  }
  const limit = Number(query.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: refusal("UNKNOWN_FILTER", "limit must be from 1 to 200") };

  const conds = [eq(objects.teamId, context.teamId), eq(objects.kind, "mirror")];
  const attachedTo = query.get("attached-to");
  if (attachedTo) conds.push(sql`${objects.attachedTo} @> ${JSON.stringify([attachedTo])}::jsonb`);
  // The kind filter normalizes the SAME way a write does, so `--kind "GitHub PR"`
  // finds the rows `--kind github-pr` created rather than silently nothing.
  const kind = query.get("kind");
  if (kind) conds.push(eq(objects.mirrorKind, normalizeMirrorKind(kind)));
  const coordsLike = query.get("coords-like");
  if (coordsLike) {
    if (coordsLike.length > 200) return { ok: false, error: refusal("UNKNOWN_FILTER", "coords-like must be at most 200 characters") };
    // A substring match, not a glob: `%` and `_` in the pattern are escaped, so
    // `owner/repo#` means what it looks like.
    conds.push(ilike(objects.mirrorCoords, `%${coordsLike.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  }

  const rows = await db.select().from(objects).where(and(...conds)).orderBy(asc(objects.mirrorKind), asc(objects.mirrorCoords)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const truncated = rows.length > limit;
  const total = truncated ? Number((await db.select({ n: count() }).from(objects).where(and(...conds)))[0]?.n ?? page.length) : page.length;
  return { ok: true, value: { mirrors: page.map(mirrorShape), total, truncated, viewerLoop: context.run?.loopId ?? null } };
}

/**
 * `GET /api/mirrors/kinds` — THE VOCABULARY, SELF-EXPOSING.
 *
 * Kinds are free-form, so the only honest answer to "what kinds are there?" is
 * the ones actually in use, with counts. The canonical spellings ride along as
 * teaching, flagged `known`, so an agent can see at a glance that `github_pr`
 * and `github-pr` collapsed and that `jira-ticket` is a word this team invented.
 */
export async function mirrorKinds(context: ApiContext): Promise<ApiResult<Record<string, unknown>>> {
  const rows = await db
    .select({ kind: objects.mirrorKind, n: count() })
    .from(objects)
    .where(and(eq(objects.teamId, context.teamId), eq(objects.kind, "mirror")))
    .groupBy(objects.mirrorKind)
    .orderBy(asc(objects.mirrorKind));
  return { ok: true, value: {
    kinds: rows.map((row) => ({ kind: row.kind ?? "", count: Number(row.n), known: Boolean(knownMirrorKind(row.kind ?? "")) })),
    canonical: MIRROR_KINDS.map((spec) => ({ kind: spec.kind, what: spec.what, coords: spec.example })),
  } };
}

export async function showMirror(id: string, context: ApiContext): Promise<ApiResult<Record<string, unknown>>> {
  const row = await store.getObject(undefined, id);
  if (!row || row.teamId !== context.teamId) return { ok: false, error: refusal("NOT_FOUND", `${id} was not found`) };
  if (row.kind !== "mirror") return { ok: false, error: refusal("WRONG_KIND", `${id} is a ${row.kind}, not a mirror`) };
  const events = await store.listObjectEvents(undefined, id);
  return { ok: true, value: { mirror: mirrorShape(row), events: events.map(mirrorEventShape) } };
}

/** The event tail's wire shape. Duplicated from `objectApi.eventShape` rather
 *  than imported, so this module has NO runtime edge back to `objectApi` — which
 *  imports it, and a cycle between the two would be a real hazard at boot. */
function mirrorEventShape(row: KernelEvent) {
  return { id: row.id, seq: row.seq, objectId: row.objectId, kind: row.kind, entrance: row.entrance, actor: row.actorId, transition: row.transition, diff: row.diff, note: row.note, ts: row.ts };
}

// -------------------------------------------------------------------- update

/**
 * `PATCH /api/mirrors/:id` — the NOTE, and nothing else.
 *
 * The note is a human label ("seed article PR"), so a typo in it is worth being
 * able to fix. `coords` and `kind` are refused BY NAME with the legal move,
 * because that refusal is the one place an agent learns the model: a different
 * PR is a different mirror, so repointing this row would silently rewrite every
 * timeline that already cites it.
 */
export async function patchMirror(id: string, body: unknown, context: ApiContext, now = new Date()): Promise<ApiResult<Record<string, unknown>>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: refusal("INVALID_BODY", "mirror patch must be a JSON object") };
  const rec = body as Record<string, unknown>;
  for (const key of ["coords", "kind", "externalKind", "mirrorCoords", "mirrorKind"]) {
    if (!Object.hasOwn(rec, key)) continue;
    return { ok: false, error: refusal(
      "IMMUTABLE_COORDS",
      `a mirror's ${key === "coords" || key === "mirrorCoords" ? "coords" : "kind"} cannot be changed — they are the external thing's identity`,
      [{ path: key, message: "fixed at creation", got: String(rec[key] ?? "") }],
      MIRROR_COORDS_IMMUTABLE_HINT,
    ) };
  }
  // The named ones an author reaches for when they mean to cache. Refused BY
  // NAME rather than as a generic unknown key, because "unknown key" reads as a
  // spelling problem and this is a modelling one.
  for (const key of ["state", "status", "external_state", "externalState", "merged", "closed", "payload", "body"]) {
    if (!Object.hasOwn(rec, key)) continue;
    return { ok: false, error: refusal("MIRROR_STATELESS", `a mirror has no ${key}`, [{ path: key, message: "a mirror is a pointer, never a cache of external state", got: key }], MIRROR_STATELESS_HINT) };
  }
  const unknown = Object.keys(rec).find((key) => key !== "note");
  if (unknown) return { ok: false, error: refusal("UNKNOWN_KEY", `unknown key "${unknown}" in a mirror patch`, [{ path: unknown, message: "unknown key", got: unknown }], "a mirror patch accepts: note") };
  if (!Object.hasOwn(rec, "note")) return { ok: false, error: refusal("INVALID_BODY", "mirror patch requires note", [], "the note is the only editable field a mirror has") };
  if (rec.note !== null && typeof rec.note !== "string") return { ok: false, error: refusal("SCHEMA_VIOLATION", "note must be text or null") };

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    const mirror = await store.getObjectForUpdate(tx, id);
    if (!mirror || mirror.teamId !== context.teamId) return { ok: false as const, error: refusal("NOT_FOUND", `${id} was not found`) };
    if (mirror.kind !== "mirror") return { ok: false as const, error: refusal("WRONG_KIND", `${id} is a ${mirror.kind}, not a mirror`) };
    const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim() : null;
    const updated = await applyUpdateIn(tx, { objectId: id, actor: context.actor, now: now.toISOString(), fields: { title: note }, eventKind: "mirror-relabelled" });
    if (!updated.ok) return { ok: false as const, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
    return { ok: true as const, value: { changed: updated.changed, mirror: mirrorShape(updated.object), event: updated.event?.id ?? null, diff: updated.event?.diff ?? {} } };
  });
}

/** Only a file-authored kind can carry a `mirrors:` block, and it is the create
 *  path that consumes it — exported so `objectApi` can assert the pairing. */
export function acceptsInlineMirrors(kind: ObjectKind): boolean {
  return isArtifactKind(kind);
}

export type { ApiRefusal };
