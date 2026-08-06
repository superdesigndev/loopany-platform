/**
 * The one attached-charter resolver and mutator.
 *
 * A charter is stored in the kernel doc engine but is loop configuration, not
 * product output. Its identity is fully derived from (team, loop), and every
 * resolver verifies every stored facet before returning bytes. Whole-body
 * changes compare-and-swap on the latest event seq.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import * as store from "../db/kernelStore.js";
import { createLoopIn } from "../db/store.js";
import { loops } from "../db/schema.js";
import type { Loop, NewLoop } from "../db/schema.js";
import type { KernelObject } from "../db/kernel-schema.js";
import { appendOrganicEvent, applyUpdateIn, createObjectIn } from "./applyTransition.js";
import { charterDocId, charterKey } from "./ids.js";
import { refusal, type ApiRefusal } from "./refusals.js";
import type { Actor } from "./types.js";
import type { ApiContext } from "./apiAuth.js";

export const CHARTER_MAX_BYTES = 512 * 1024;

export interface CharterSnapshot {
  id: string;
  loopId: string;
  key: string;
  docKind: "charter";
  format: "markdown";
  body: string;
  version: number;
  updatedAt: string;
}

export type CharterResult<T> = { ok: true; value: T } | { ok: false; error: ApiRefusal };

interface CreateLoopWithCharterInput {
  loop: Omit<NewLoop, "id" | "createdAt" | "updatedAt" | "teamId"> & { id?: string; teamId: string };
  body: string;
  actor: Actor;
  now: string;
}

class AtomicCharterCreateRefusal extends Error {
  constructor(readonly refusal: ApiRefusal) {
    super(refusal.message);
  }
}

interface CharterIdentity {
  teamId: string;
  loopId: string;
}

interface EnsureCharterInput extends CharterIdentity {
  loopName?: string | null;
  body: string;
  actor: Actor;
  now: string;
  createdByRun?: string | null;
}

interface ReplaceCharterInput extends CharterIdentity {
  body: string;
  expectedVersion: number;
  actor: Actor;
  now: string;
  source: "owner-edit" | "http" | "report-fallback";
}

export interface CharterCarryInput extends CharterIdentity {
  loopName?: string | null;
  runId: string;
  candidate?: { baseVersion: number | null; content: string };
  legacyContent?: string | null;
  storedLegacyContent?: string | null;
  now: string;
}

export interface CharterCarryResult {
  charter: CharterSnapshot | null;
  changed: boolean;
  seeded: boolean;
  warning?: string;
}

function tooLarge(body: string): ApiRefusal | undefined {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= CHARTER_MAX_BYTES) return undefined;
  return refusal(
    "TOO_LARGE",
    `charter body is ${bytes} bytes; the complete-body limit is ${CHARTER_MAX_BYTES}`,
    [{ path: "body", message: "complete charter exceeds limit", got: String(bytes), expected: `<= ${CHARTER_MAX_BYTES}` }],
    "shorten the charter and retry; Loopany never truncates a charter into a valid-looking partial document",
  );
}

function invalidCharterBody(body: string): ApiRefusal | undefined {
  if (!body.includes("\0")) return tooLarge(body);
  return refusal(
    "INVALID_BODY",
    "charter body contains a NUL byte, which cannot be stored as PostgreSQL text",
    [{ path: "body", message: "remove the NUL byte" }],
    "save the charter as ordinary UTF-8 markdown and retry",
  );
}

function identityError(row: KernelObject, { teamId, loopId }: CharterIdentity): ApiRefusal | undefined {
  const id = charterDocId(teamId, loopId);
  const key = charterKey(loopId);
  if (
    row.id === id &&
    row.teamId === teamId &&
    row.kind === "doc" &&
    row.docKind === "charter" &&
    row.key === key &&
    row.createdByLoop === loopId &&
    row.format === "markdown"
  ) return undefined;
  return refusal(
    "ID_COLLISION",
    `${id} does not have the complete identity of ${loopId}'s charter`,
    [{ path: "id", message: "derived charter identity resolved to incompatible stored facets", got: row.id, expected: id }],
    "nothing was written; this is an integrity fault and must be investigated rather than worked around",
  );
}

async function loopInTeam(tx: store.KernelExec, teamId: string, loopId: string) {
  return (await tx.select().from(loops).where(and(eq(loops.id, loopId), eq(loops.teamId, teamId))).limit(1))[0];
}

async function snapshot(tx: store.KernelExec, row: KernelObject, loopId: string): Promise<CharterSnapshot> {
  const event = await store.latestObjectEvent(tx, row.id);
  if (!event) throw new Error(`charter ${row.id} has no event version`);
  return {
    id: row.id,
    loopId,
    key: row.key!,
    docKind: "charter",
    format: "markdown",
    body: row.body ?? "",
    version: event.seq,
    updatedAt: row.updatedAt,
  };
}

/** Resolve the deterministic attachment. Missing is a normal dual-read state. */
export async function readCharter(teamId: string, loopId: string): Promise<CharterResult<CharterSnapshot | null>> {
  const loop = await loopInTeam(db as unknown as store.KernelExec, teamId, loopId);
  if (!loop) return { ok: false, error: refusal("NOT_FOUND", `${loopId} was not found`) };
  const row = await store.getObject(undefined, charterDocId(teamId, loopId));
  if (!row) return { ok: true, value: null };
  const bad = identityError(row, { teamId, loopId });
  if (bad) return { ok: false, error: bad };
  return { ok: true, value: await snapshot(db as unknown as store.KernelExec, row, loopId) };
}

export async function ensureCharter(input: EnsureCharterInput): Promise<CharterResult<{ charter: CharterSnapshot; created: boolean }>> {
  const invalid = invalidCharterBody(input.body);
  if (invalid) return { ok: false, error: invalid };
  return db.transaction(async (rawTx) => ensureCharterIn(rawTx as unknown as store.KernelExec, input));
}

/** Create the production loop row and its attached charter in one transaction. */
export async function createLoopWithCharter(
  input: CreateLoopWithCharterInput,
): Promise<CharterResult<{ loop: Loop; charter: CharterSnapshot }>> {
  const invalid = invalidCharterBody(input.body);
  if (invalid) return { ok: false, error: invalid };
  try {
    const value = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as store.KernelExec;
      const loop = await createLoopIn(tx, input.loop, input.now);
      const made = await ensureCharterIn(tx, {
        teamId: input.loop.teamId,
        loopId: loop.id,
        loopName: loop.name,
        body: input.body,
        actor: input.actor,
        now: input.now,
      });
      if (!made.ok) throw new AtomicCharterCreateRefusal(made.error);
      return { loop, charter: made.value.charter };
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof AtomicCharterCreateRefusal) return { ok: false, error: cause.refusal };
    throw cause;
  }
}

/** Transactional form used by atomic loop creation and legacy report seeding. */
export async function ensureCharterIn(
  tx: store.KernelExec,
  input: EnsureCharterInput,
): Promise<CharterResult<{ charter: CharterSnapshot; created: boolean }>> {
  const invalid = invalidCharterBody(input.body);
  if (invalid) return { ok: false, error: invalid };
  if (!(await loopInTeam(tx, input.teamId, input.loopId))) {
    return { ok: false, error: refusal("NOT_FOUND", `${input.loopId} was not found`) };
  }
  const made = await createObjectIn(tx, {
    id: charterDocId(input.teamId, input.loopId),
    teamId: input.teamId,
    kind: "doc",
    docKind: "charter",
    status: "current",
    key: charterKey(input.loopId),
    format: "markdown",
    title: `${input.loopName ?? input.loopId} charter`,
    body: input.body,
    payload: null,
    createdByLoop: input.loopId,
    createdByRun: input.createdByRun ?? null,
    actor: input.actor,
    now: input.now,
  });
  if (!made.ok) return { ok: false, error: refusal(made.code as never, made.message, made.issues, made.hint) };
  const bad = identityError(made.object, input);
  if (bad) return { ok: false, error: bad };
  return { ok: true, value: { charter: await snapshot(tx, made.object, input.loopId), created: made.created } };
}

export async function replaceCharter(input: ReplaceCharterInput): Promise<CharterResult<{ charter: CharterSnapshot; changed: boolean }>> {
  const invalid = invalidCharterBody(input.body);
  if (invalid) return { ok: false, error: invalid };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    if (!(await loopInTeam(tx, input.teamId, input.loopId))) {
      return { ok: false, error: refusal("NOT_FOUND", `${input.loopId} was not found`) };
    }
    const id = charterDocId(input.teamId, input.loopId);
    const before = await store.getObjectForUpdate(tx, id);
    if (!before) return { ok: false, error: refusal("NOT_FOUND", `${input.loopId} has no charter yet`) };
    const bad = identityError(before, input);
    if (bad) return { ok: false, error: bad };
    const current = await snapshot(tx, before, input.loopId);
    if ((before.body ?? "") === input.body) return { ok: true, value: { charter: current, changed: false } };
    if (input.expectedVersion !== current.version) {
      return {
        ok: false,
        error: refusal(
          "VERSION_CONFLICT",
          `${input.loopId}'s charter is at version ${current.version}, not ${input.expectedVersion}`,
          [{ path: "If-Match", message: "stale charter version", got: String(input.expectedVersion), expected: String(current.version) }],
        ),
      };
    }
    const updated = await applyUpdateIn(tx, {
      objectId: id,
      actor: input.actor,
      now: input.now,
      fields: { body: input.body },
      eventKind: "charter-updated",
      eventPayload: { loopId: input.loopId, source: input.source },
    });
    if (!updated.ok) return { ok: false, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
    return { ok: true, value: { charter: await snapshot(tx, updated.object, input.loopId), changed: updated.changed } };
  });
}

function partialLegacyContent(body: string): boolean {
  return /^… \(truncated — last \d+KB of \d+KB\)/.test(body);
}

async function appendCarryConflictIn(tx: store.KernelExec, input: CharterIdentity & {
  expectedVersion: number | null;
  currentVersion: number;
  runId: string;
  now: string;
}): Promise<void> {
  await appendOrganicEvent(tx, {
    teamId: input.teamId,
    objectId: input.loopId,
    kind: "charter-update-conflict",
    origin: "organic",
    entrance: "agent",
    actorId: input.runId,
    transition: null,
    diff: null,
    note: null,
    payload: {
      loopId: input.loopId,
      charterDocId: charterDocId(input.teamId, input.loopId),
      expectedVersion: input.expectedVersion,
      currentVersion: input.currentVersion,
    },
    ts: input.now,
  });
}

/**
 * Apply an end-of-run file carry. Conflicts are visible refusals, not run failures.
 * A legacy daemon has no delivered charter version, so its previously stored task
 * file body is the compare-and-swap base: apply only while the canonical charter
 * still equals that body; otherwise append a conflict instead of losing divergence.
 */
export async function applyCharterCarry(input: CharterCarryInput): Promise<CharterResult<CharterCarryResult>> {
  const candidateInvalid = input.candidate ? invalidCharterBody(input.candidate.content) : undefined;
  if (candidateInvalid) return { ok: true, value: { charter: null, changed: false, seeded: false, warning: candidateInvalid.message } };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    if (!(await loopInTeam(tx, input.teamId, input.loopId))) {
      return { ok: false, error: refusal("NOT_FOUND", `${input.loopId} was not found`) };
    }
    const id = charterDocId(input.teamId, input.loopId);
    const before = await store.getObjectForUpdate(tx, id);
    if (!before) {
      const candidate = input.candidate?.baseVersion === null ? input.candidate.content : undefined;
      const legacy = input.legacyContent && !partialLegacyContent(input.legacyContent) ? input.legacyContent : undefined;
      const stored = input.storedLegacyContent && !partialLegacyContent(input.storedLegacyContent) ? input.storedLegacyContent : undefined;
      const seed = candidate ?? legacy ?? stored;
      if (seed === undefined) {
        return { ok: true, value: { charter: null, changed: false, seeded: false } };
      }
      const made = await ensureCharterIn(tx, {
        teamId: input.teamId,
        loopId: input.loopId,
        loopName: input.loopName,
        body: seed,
        actor: { entrance: "agent", actorId: input.runId },
        createdByRun: input.runId,
        now: input.now,
      });
      if (!made.ok) return made;
      if (!made.value.created && made.value.charter.body !== seed) {
        await appendCarryConflictIn(tx, { ...input, expectedVersion: null, currentVersion: made.value.charter.version });
        return { ok: true, value: { charter: made.value.charter, changed: false, seeded: false, warning: `charter carry refused: current version is ${made.value.charter.version}; the run started unseeded` } };
      }
      return { ok: true, value: { charter: made.value.charter, changed: made.value.created, seeded: made.value.created } };
    }
    const bad = identityError(before, input);
    if (bad) return { ok: false, error: bad };
    const current = await snapshot(tx, before, input.loopId);
    if (!input.candidate && input.legacyContent != null && current.body !== input.legacyContent) {
      const legacyInvalid = partialLegacyContent(input.legacyContent)
        ? "legacy task-file carry is truncated"
        : invalidCharterBody(input.legacyContent)?.message;
      const stored = input.storedLegacyContent != null && !partialLegacyContent(input.storedLegacyContent)
        ? input.storedLegacyContent
        : undefined;
      if (legacyInvalid || stored === undefined || current.body !== stored) {
        await appendCarryConflictIn(tx, { ...input, expectedVersion: null, currentVersion: current.version });
        return {
          ok: true,
          value: {
            charter: current,
            changed: false,
            seeded: false,
            warning: legacyInvalid
              ? `charter carry refused: ${legacyInvalid}`
              : `charter carry refused: current version ${current.version} changed since the legacy task file was last delivered`,
          },
        };
      }
      const updated = await applyUpdateIn(tx, {
        objectId: id,
        actor: { entrance: "agent", actorId: input.runId },
        now: input.now,
        fields: { body: input.legacyContent },
        eventKind: "charter-updated",
        eventPayload: { loopId: input.loopId, source: "legacy-report-fallback" },
      });
      if (!updated.ok) return { ok: false, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
      return { ok: true, value: { charter: await snapshot(tx, updated.object, input.loopId), changed: updated.changed, seeded: false } };
    }
    if (!input.candidate || current.body === input.candidate.content) {
      return { ok: true, value: { charter: current, changed: false, seeded: false } };
    }
    if (input.candidate.baseVersion !== current.version) {
      await appendCarryConflictIn(tx, {
        ...input,
        expectedVersion: input.candidate.baseVersion,
        currentVersion: current.version,
      });
      return {
        ok: true,
        value: {
          charter: current,
          changed: false,
          seeded: false,
          warning: `charter carry refused: current version ${current.version} replaced delivered version ${input.candidate.baseVersion ?? "unseeded"}; re-read before applying the run's edit`,
        },
      };
    }
    const updated = await applyUpdateIn(tx, {
      objectId: id,
      actor: { entrance: "agent", actorId: input.runId },
      now: input.now,
      fields: { body: input.candidate.content },
      eventKind: "charter-updated",
      eventPayload: { loopId: input.loopId, source: "report-fallback" },
    });
    if (!updated.ok) return { ok: false, error: refusal(updated.code as never, updated.message, updated.issues, updated.hint) };
    return { ok: true, value: { charter: await snapshot(tx, updated.object, input.loopId), changed: updated.changed, seeded: false } };
  });
}

function leaseScopeGuard(loopId: string, context: ApiContext): ApiRefusal | undefined {
  if (context.mode !== "lease" || context.loop?.id === loopId) return undefined;
  return refusal(
    "NOT_YOUR_CHARTER",
    `${loopId}'s charter is outside run ${context.run?.id ?? "(unknown)"}'s lease scope`,
    [{ path: "loopId", message: "must equal the lease's loop", got: loopId, expected: context.loop?.id ?? "the leased loop" }],
  );
}

export async function readCharterForContext(loopId: string, context: ApiContext): Promise<CharterResult<CharterSnapshot | null>> {
  const guard = leaseScopeGuard(loopId, context);
  return guard ? { ok: false, error: guard } : readCharter(context.teamId, loopId);
}

export async function replaceCharterForContext(
  loopId: string,
  body: string,
  expectedVersion: number,
  context: ApiContext,
  now = new Date(),
): Promise<CharterResult<{ charter: CharterSnapshot; changed: boolean }>> {
  const guard = leaseScopeGuard(loopId, context);
  if (guard) return { ok: false, error: guard };
  return replaceCharter({
    teamId: context.teamId,
    loopId,
    body,
    expectedVersion,
    actor: context.actor,
    now: now.toISOString(),
    source: "http",
  });
}

/** Visible operational event for a stale end-of-run carry; the run still finalizes. */
export async function recordCharterCarryConflict(input: CharterIdentity & {
  expectedVersion: number | null;
  currentVersion: number;
  actor: Actor;
  now: string;
}): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as store.KernelExec;
    await appendCarryConflictIn(tx, {
      teamId: input.teamId,
      loopId: input.loopId,
      expectedVersion: input.expectedVersion,
      currentVersion: input.currentVersion,
      runId: input.actor.actorId,
      now: input.now,
    });
  });
}
