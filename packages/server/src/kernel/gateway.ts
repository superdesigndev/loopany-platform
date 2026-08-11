/**
 * Kernel CLI gateway — the HTTP seam for POST /api/kernel/cli (milestone M5).
 *
 * It is a thin ROUTER: authorize a device (`dk_`) token to a machine → its team,
 * OVERRIDE the actor identity from the credential (never trust the body's actor),
 * decide IN-PROCESS with `@loopany/kernel`, then persist transactionally via
 * `kernel/store.ts`. The server runs the SAME kernel package the local driver
 * runs (design §9), so authority-side validation cannot drift between backends.
 *
 * Two typed error shapes ride back distinctly, per design §12 (the M1F "apply
 * conflict shape is binary" open question): a `Refusal` (decide rejected the
 * command — bad field, cron, reference, …) and an `ApplyConflict` (a stale CAS /
 * active-run precondition lost at persist time). We do NOT unify them here
 * (unification is a recorded open question); the response carries whichever
 * fired, and the HTTP status distinguishes: 200 ok, 422 refusal, 409 conflict.
 */
import {
  type ApplyConflict,
  type Command,
  type KernelEvent,
  type Provenance,
  type RunRecord,
  type Snapshot,
  decide,
  tick,
} from "@loopany/kernel";

import * as store from "../db/store.js";
import { isDeviceTokenShape, machineIdFromToken, sha256 } from "../gateway/tokens.js";
import { applyChangesetForTeam, readEvents, readSnapshot } from "./store.js";

export interface KernelHttpResult {
  status: number;
  body: KernelCliResponse;
}

export interface KernelCliResponse {
  ok: boolean;
  /** decide-time typed rejection (bad command). */
  refusal?: { code: string; message: string; issues?: string[]; hint?: string };
  /** persist-time CAS/active-run conflict (a stale write lost). */
  conflict?: { kind: string; id: string; message: string };
  /** Loud human-facing echoes (e.g. "re-armed cron …"). */
  notices: string[];
  /** The decision's result payload (e.g. the created object's id) on success. */
  result?: { id: string; existing?: boolean };
  /** On a READ request (`{read:true}`): the team's full snapshot + event streams,
   *  so the remote CLI backend can render show/list/inbox/search off authority
   *  state. Absent on write/tick responses. */
  snapshot?: Snapshot;
  events?: Record<string, KernelEvent[]>;
  /** On a TICK request: the number of per-fire changesets applied. */
  applied?: number;
}

/** The POST /api/kernel/cli body. A discriminated union so the ONE route serves
 *  every remote-backend need: a write `Command`, a host `tick`, or a `read` that
 *  returns the authority snapshot. Old clients that POST a bare `{command}` still
 *  parse (the `command` branch). `now` is an OPTIONAL deterministic-clock override
 *  (the local driver's `--now` twin, §13 M3) — the two backends must both be
 *  reproducible for the M6 conformance double-run; a client-supplied instant only
 *  affects schedule times the owner already controls, unlike the actor identity
 *  which is ALWAYS credential-derived and never trusted from the body. */
export interface KernelCliBody {
  command?: unknown;
  tick?: boolean;
  read?: boolean;
  now?: string;
}

/** Resolve a `dk_` device credential to its `{teamId, actor}` scope, or a flat
 *  401 (enumeration-safe: unknown machine and wrong token hash are indistinct).
 *  Every request kind (command/tick/read) shares this ONE auth chokepoint. */
async function resolveScope(
  deviceToken: string,
): Promise<{ teamId: string; actor: Provenance } | null> {
  if (!isDeviceTokenShape(deviceToken)) return null;
  const machineId = machineIdFromToken(deviceToken);
  const machine = await store.getMachine(machineId);
  if (!machine) return null;
  if (machine.tokenHash && machine.tokenHash !== sha256(deviceToken)) return null;
  const teamId = machine.teamId ?? store.teamIdForUser(machine.userId);
  // Actor identity is OVERRIDDEN from the credential — the body's provenance (if
  // any) is ignored. A device token is a human owner acting from their machine.
  const actor: Provenance = { entrance: "human", actorId: machine.userId ?? "shared" };
  return { teamId, actor };
}

/**
 * Dispatch one kernel request over a device credential — a write `Command`, a
 * host `tick`, or a `read` of the authority snapshot (the discriminated
 * {@link KernelCliBody}). Back-compat: passing a bare Command (the old `command`
 * arg) is still accepted and routed as a write.
 *
 * `deviceToken` is the `dk_` machine credential (same machinery as every other
 * machine route). A command's ACTOR is derived from the credential here — the
 * body never dictates who acted (a client could otherwise forge provenance).
 */
export async function kernelCli(
  deviceToken: string,
  body: KernelCliBody | unknown,
): Promise<KernelHttpResult> {
  const scope = await resolveScope(deviceToken);
  if (!scope) return unauth();
  const { teamId, actor } = scope;

  // Normalize: a legacy bare-Command call (or any non-envelope value) is a write.
  const req: KernelCliBody =
    isRecord(body) && ("command" in body || body.tick === true || body.read === true)
      ? (body as KernelCliBody)
      : { command: body };
  const now = req.now ?? new Date().toISOString();

  if (req.read) return await readRequest(teamId);
  if (req.tick) return await tickRequest(teamId, now);
  return await commandRequest(teamId, actor, req.command, now);
}

async function commandRequest(
  teamId: string,
  actor: Provenance,
  command: unknown,
  now: string,
): Promise<KernelHttpResult> {
  const decision = decide(command as Command, await readSnapshot(teamId), actor, now);
  if (!decision.ok) {
    return { status: 422, body: { ok: false, notices: [], refusal: decision.refusal } };
  }
  const applied = await applyChangesetForTeam(teamId, decision.changeset);
  if (!applied.ok) {
    return { status: 409, body: { ok: false, notices: decision.notices, conflict: applied.conflict } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      notices: decision.notices,
      ...(decision.result ? { result: decision.result } : {}),
    },
  };
}

/** The host tick (§5.2) — the clock's whole job, run server-side so a remote
 *  `loopany-kernel tick` fires the team's due triggers. Each per-fire changeset
 *  is applied on its OWN transaction (CAS-validated), so a conflict on one fire
 *  surfaces without losing the fires that already landed — the same
 *  atomically-per-fire guarantee the local `runTick` gives. */
async function tickRequest(teamId: string, now: string): Promise<KernelHttpResult> {
  const r = await tickTeamAtAuthority(teamId, now);
  if (r.conflict) {
    return { status: 409, body: { ok: false, notices: r.notices, conflict: r.conflict, applied: r.applied } };
  }
  return { status: 200, body: { ok: true, notices: r.notices, applied: r.applied } };
}

/** Run the kernel tick at the authority for ONE team, applying each per-fire
 *  changeset on its own CAS-validated transaction (a conflict on one fire never
 *  loses the fires that already landed). Reports the PENDING RUNS the tick
 *  minted so the caller (the kernel sweep) can wake the addressed machines'
 *  long-polls - the mint itself is durable either way (deferred-inbox). */
export async function tickTeamAtAuthority(
  teamId: string,
  now: string,
): Promise<{ applied: number; notices: string[]; minted: RunRecord[]; conflict?: ApplyConflict }> {
  const result = tick(await readSnapshot(teamId), now);
  let applied = 0;
  const minted: RunRecord[] = [];
  for (const cs of result.changesets) {
    const res = await applyChangesetForTeam(teamId, cs);
    if (!res.ok) {
      return { applied, notices: result.notices, minted, conflict: res.conflict };
    }
    applied++;
    for (const m of cs.runs) {
      if (m.op === "insert" && m.run.state === "pending") minted.push(m.run);
    }
  }
  return { applied, notices: result.notices, minted };
}

/** A read of the authority snapshot + every object's event stream. The remote
 *  CLI backend renders show/list/inbox/search off this (the reads never mutate,
 *  so no lock/transaction). The conformance harness compares this projection to
 *  the local file driver's. */
async function readRequest(teamId: string): Promise<KernelHttpResult> {
  const snapshot = await readSnapshot(teamId);
  const all = await readEvents(teamId);
  const events: Record<string, KernelEvent[]> = {};
  for (const ev of all) {
    (events[ev.objectId] ??= []).push(ev);
  }
  return { status: 200, body: { ok: true, notices: [], snapshot, events } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unauth(): KernelHttpResult {
  return {
    status: 401,
    body: { ok: false, notices: [], refusal: { code: "UNAUTHORIZED", message: "unknown or invalid machine credential" } },
  };
}
