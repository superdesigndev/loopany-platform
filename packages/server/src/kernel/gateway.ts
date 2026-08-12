/**
 * Kernel CLI gateway — the HTTP seam for POST /api/kernel/cli (milestone M5).
 *
 * It is a thin ROUTER: authorize a device (`dk_`) token to a machine → its team,
 * derive authority from the credential, accept only bounded audit context,
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
  type TimelineItem,
  decide,
  tick,
  timelineView,
} from "@loopany/kernel";

import { timingSafeEqual } from "node:crypto";
import * as store from "../db/store.js";
import { isDeviceTokenShape, machineIdFromToken, resolveLease, retireLeasesForRun, sha256 } from "../gateway/tokens.js";
import { applyChangesetForTeam, readEvents, readSnapshot } from "./store.js";
import { notifyKernelChangeset } from "./notify.js";

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
  /** On a READ: presence per TEAM ALIAS ("online" | "asleep" | "offline") for
   *  every machine reachable in the team - the Loops projection's machine
   *  availability (review round 3). */
  machinePresence?: Record<string, string>;
  /** On a TICK request: the number of per-fire changesets applied. */
  applied?: number;
  /** On a TIMELINE request: the projected items (bounded, newest first). */
  timeline?: TimelineItem[];
}

/** The POST /api/kernel/cli body. A discriminated union so the ONE route serves
 *  every remote-backend need: a write `Command`, a host `tick`, or a `read` that
 *  returns the authority snapshot. Old clients that POST a bare `{command}` still
 *  parse (the `command` branch). `now` is an OPTIONAL deterministic-clock override
 *  (the local driver's `--now` twin, §13 M3) — the two backends must both be
 *  reproducible for the M6 conformance double-run; a client-supplied instant only
 *  affects schedule times the owner already controls, unlike the actor identity
 *  which never changes credential-derived authorization. */
export interface KernelCliBody {
  command?: unknown;
  /** Audit hint from an owner CLI. It never affects credential scope. */
  provenance?: unknown;
  tick?: boolean;
  read?: boolean;
  /** The BOUNDED team-timeline query (kernel-team-timeline): the server runs
   *  the shared timelineView so a remote CLI never downloads every event. */
  timeline?: { since?: unknown; limit?: unknown; taskId?: unknown; actor?: unknown; all?: unknown };
  now?: string;
  /** The SIMULATOR time-authority capability (kernel-authority-clock-seam):
   *  presenting the server's LOOPANY_KERNEL_SIM_SECRET here (timing-safe
   *  compared) lets `now` be honored even on a RUN credential. Unverifiable
   *  presentation = loud 403; no secret configured = the capability does not
   *  exist. Never a mode, never ambient. */
  simAuthority?: unknown;
}

/** Verify a presented simulator time authority against the configured secret.
 *  Three-state by design: `absent` (nothing presented - the normal case),
 *  `granted` (secret configured AND matches, timing-safe), `refused` (presented
 *  but unverifiable - wrong value OR no secret configured; the caller must fail
 *  LOUD, because a simulator silently falling back to real time corrupts its
 *  own determinism without a trace). */
function checkSimAuthority(presented: unknown): "absent" | "granted" | "refused" {
  if (presented === undefined || presented === null) return "absent";
  const secret = process.env.LOOPANY_KERNEL_SIM_SECRET;
  if (typeof presented !== "string" || !secret) return "refused";
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return "refused";
  return timingSafeEqual(a, b) ? "granted" : "refused";
}

/** Resolve a credential to its `{teamId, actor, run?}` scope, or a flat 401
 *  (enumeration-safe: unknown machine and wrong token hash are indistinct).
 *  Every request kind (command/tick/read) shares this ONE auth chokepoint.
 *
 *  Two credential classes (P0 stage D):
 *  - `dk_` device token -> the OWNER scope (human actor, full verb surface).
 *  - `rk_` run lease with kernel markers -> the RUN scope: team from the lease,
 *    actor {agent-run, runId, sessionId} so every write is attributed to the
 *    run, and a VERB SUBSET enforced by the caller (`runVerbRefusal`). A
 *    production (non-kernel) rk_ lease resolves to null here - it has no kernel
 *    team and belongs to the loop surface, not this route. */
async function resolveScope(
  credential: string,
): Promise<{ teamId: string; actor: Provenance; machineId?: string; run?: { runId: string; state: "active" | "terminal-grace" } } | null> {
  if (credential.startsWith("rk_")) {
    const lease = await resolveLease(credential);
    if (!lease?.kernelTeamId) return null;
    return {
      teamId: lease.kernelTeamId,
      actor: { entrance: "agent-run", actorId: lease.runId, sessionId: `spawn-${lease.runId}` },
      run: { runId: lease.runId, state: lease.state },
    };
  }
  if (!isDeviceTokenShape(credential)) return null;
  const machineId = machineIdFromToken(credential);
  const machine = await store.getMachine(machineId);
  if (!machine) return null;
  if (machine.tokenHash && machine.tokenHash !== sha256(credential)) return null;
  const teamId = machine.teamId ?? store.teamIdForUser(machine.userId);
  // This is the safe fallback. A bounded audit hint may refine it later, but
  // never changes the credential's authority or team scope.
  const actor: Provenance = { entrance: "human", actorId: machine.userId ?? "shared" };
  return { teamId, actor, machineId };
}

/** Accept a bounded audit hint only for a device credential. The credential
 * still owns authorization and team scope. Agent machine aliases are derived
 * server-side from that credential, never accepted from the request body. */
async function deviceActor(
  scope: { teamId: string; actor: Provenance; machineId?: string },
  raw: unknown,
): Promise<Provenance> {
  if (!isRecord(raw)) return scope.actor.actorId === "shared" ? { entrance: "device", actorId: "shared" } : scope.actor;
  const entrance = raw.entrance;
  const actorId = raw.actorId;
  const sessionId = raw.sessionId;
  if (
    (entrance !== "human" && entrance !== "agent" && entrance !== "device") ||
    typeof actorId !== "string" ||
    actorId.length < 1 ||
    actorId.length > 200 ||
    (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 200))
  ) {
    return scope.actor;
  }
  if (entrance === "agent" && scope.machineId && (actorId === "codex" || actorId === "claude")) {
    const alias = (await store.listTeamAliases(scope.teamId)).find((row) => row.machineId === scope.machineId)?.alias;
    return { entrance, actorId: `${alias ?? "device"}/${actorId}`, ...(sessionId ? { sessionId } : {}) };
  }
  return { entrance, actorId, ...(sessionId ? { sessionId } : {}) };
}

/** The RUN credential's verb subset (P0 stage D). The hard wall is the TEAM
 *  (scope resolution above); within it a run may create/update/note/doc-put/
 *  mirror-add ANY task (cross-task writes are the pull-mode collaboration
 *  contract - claiming another loop's minted task, attaching docs) and finish
 *  ONLY ITS OWN run. Owner/host surfaces (tick, read-all is allowed, delete,
 *  run-claim) are refused with a clear 403 body. A TERMINAL-GRACE lease (the
 *  run was reclaimed) refuses EVERYTHING with 409 - kernel recovery retires
 *  leases outright so this state is normally unreachable, but production
 *  `terminalizeLease` targets by runId, so the guard is defense-in-depth
 *  (parity with production run-token semantics). Returns null when allowed. */
function runVerbRefusal(
  run: { runId: string; state: "active" | "terminal-grace" },
  req: KernelCliBody,
): { status: number; code: string; message: string } | null {
  if (run.state === "terminal-grace") {
    return {
      status: 409,
      code: "CONFLICT",
      message: "this run was reclaimed; its credential can no longer read or write",
    };
  }
  if (req.tick) return { status: 403, code: "FORBIDDEN", message: "a run credential cannot host-tick (owner/host surface)" };
  if (req.read || req.timeline !== undefined) return null; // reads are team-scoped and safe (show/list/inbox/timeline)
  const op = isRecord(req.command) ? String((req.command as { op?: unknown }).op ?? "") : "";
  const allowed = new Set(["create", "update", "note", "doc-put", "mirror-add", "run-finish"]);
  if (!allowed.has(op)) {
    return { status: 403, code: "FORBIDDEN", message: `a run credential cannot issue "${op}" (allowed: ${[...allowed].join(", ")})` };
  }
  if (op === "run-finish") {
    const runId = String((req.command as { runId?: unknown }).runId ?? "");
    if (runId !== run.runId) {
      return { status: 403, code: "FORBIDDEN", message: "a run may finish only ITS OWN run" };
    }
  }
  return null;
}

/**
 * Dispatch one kernel request over a device credential — a write `Command`, a
 * host `tick`, or a `read` of the authority snapshot (the discriminated
 * {@link KernelCliBody}). Back-compat: passing a bare Command (the old `command`
 * arg) is still accepted and routed as a write.
 *
 * `deviceToken` is the `dk_` machine credential (same machinery as every other
 * machine route). The body may refine audit attribution, but cannot change the
 * credential's team, permissions, or machine alias.
 */
export async function kernelCli(
  deviceToken: string,
  body: KernelCliBody | unknown,
): Promise<KernelHttpResult> {
  const scope = await resolveScope(deviceToken);
  if (!scope) return unauth();
  const { teamId } = scope;

  // Normalize: a legacy bare-Command call (or any non-envelope value) is a write.
  const req: KernelCliBody =
    isRecord(body) && ("command" in body || body.tick === true || body.read === true || "timeline" in body)
      ? (body as KernelCliBody)
      : { command: body };
  const actor = scope.run ? scope.actor : await deviceActor(scope, req.provenance);
  // A RUN credential never dictates time: honoring body.now would let a run
  // backdate its own history or steer follow-up/backoff math. The deterministic
  // `now` override stays an owner/test seam on DEVICE credentials only.
  //
  // The ONE exception is a CAPABILITY, never a mode: a simulator deployment
  // configures LOOPANY_KERNEL_SIM_SECRET, and only a request PRESENTING that
  // secret (body.simAuthority, compared timing-safe) may pin `now` on a run
  // credential - so the whole virtual world (device ticks AND agent callbacks)
  // shares one deterministic timeline. With no secret configured the capability
  // is unreachable; presenting an authority that cannot be verified is a LOUD
  // 403 (a misconfigured simulator must never silently fall back to real time
  // and corrupt its own determinism). Ordinary rk_ requests are untouched under
  // every configuration - the kernel-authority-clock-seam invariant.
  const grant = checkSimAuthority(req.simAuthority);
  if (grant === "refused") {
    return {
      status: 403,
      body: {
        ok: false,
        notices: [],
        refusal: { code: "FORBIDDEN", message: "simulator time authority not verifiable (wrong or unconfigured LOOPANY_KERNEL_SIM_SECRET)" },
      },
    };
  }
  const now =
    scope.run && grant !== "granted" ? new Date().toISOString() : (req.now ?? new Date().toISOString());

  // Run-credential verb subset (stage D): team is the hard wall (already
  // resolved), the subset keeps owner/host surfaces off a run token.
  if (scope.run) {
    const refusedVerb = runVerbRefusal(scope.run, req);
    if (refusedVerb) {
      return {
        status: refusedVerb.status,
        body: { ok: false, notices: [], refusal: { code: refusedVerb.code, message: refusedVerb.message } },
      };
    }
  }

  if (req.read) return await readRequest(teamId);
  if (req.timeline !== undefined) return await timelineRequest(teamId, req.timeline);
  if (req.tick) return await tickRequest(teamId, now);

  // RUN POSTCONDITION: an exit-code-0 agent process is NOT a result. The
  // daemon's run-finish(done) rides the rk_ credential; when the run wrote NO
  // durable event beyond the claim machinery, the "success" is a protocol
  // failure (missing CLI, forgotten protocol, no-op process) and settles as
  // FAILED with a note naming it — so a silent agent can never mark a one-shot
  // task's run done. An explicit no-op note ("nothing actionable") is an honest
  // result and passes. A DEVICE credential's finish is an owner override and is
  // never second-guessed.
  let command = req.command;
  if (scope.run && isRecord(command) && command.op === "run-finish" && command.outcome === "done") {
    if (!(await runProducedEvidence(teamId, scope.run.runId))) {
      command = {
        ...command,
        outcome: "failed",
        note: `postcondition: the agent exited 0 but wrote NO durable event this run — not a result (original note: ${String(command.note ?? "")})`,
      };
    }
  }
  const result = await commandRequest(teamId, actor, command, now);
  // A successful run-finish CONSUMES the run's credential: retire its leases so
  // a completed run's rk_ never lingers as a live team-write token (and a
  // duplicate finish gets a clean 401, single-shot like production reports).
  if (result.status === 200 && isRecord(req.command) && req.command.op === "run-finish") {
    await retireLeasesForRun(String((req.command as { runId?: unknown }).runId ?? ""));
  }
  return result;
}

/** Did `runId` write any durable EVIDENCE this run? Evidence = an event carrying
 *  the run's forced provenance, excluding the CLAIM MACHINERY the server itself
 *  wrote at claim time: `run-started`, and the one-shot `status-changed` stamped
 *  at the exact claim instant (excluded by kind+timestamp, not ordering, so a
 *  same-millisecond agent note still counts). A note, doc, mirror, task update,
 *  or cross-task create all count — including an explicit "nothing actionable"
 *  note, which is an honest no-op result. */
async function runProducedEvidence(teamId: string, runId: string): Promise<boolean> {
  const all = await readEvents(teamId);
  const mine = all.filter((e) => e.provenance.entrance === "agent-run" && e.provenance.actorId === runId);
  const startedAt = mine.find((e) => e.kind === "run-started")?.at;
  return mine.some(
    (e) =>
      e.kind !== "run-started" &&
      !(e.kind === "status-changed" && startedAt !== undefined && e.at === startedAt),
  );
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
  // Owner notifications ride the just-applied changeset (human assignment,
  // auto-park, ...). Best-effort by construction - never blocks the write.
  await notifyKernelChangeset(teamId, decision.changeset);
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

/** The BOUNDED timeline query: sanitize the wire opts, cap the limit, run the
 *  SHARED timelineView at the authority (identical semantics to the local file
 *  driver by construction). Team scoping is the credential scope above. */
async function timelineRequest(
  teamId: string,
  raw: NonNullable<KernelCliBody["timeline"]>,
): Promise<KernelHttpResult> {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const limit = Math.min(Math.max(Number(raw.limit) || 50, 1), 200);
  const items = timelineView(await readSnapshot(teamId), await readEvents(teamId), {
    since: str(raw.since),
    taskId: str(raw.taskId),
    actor: str(raw.actor),
    all: raw.all === true,
    limit,
  });
  return { status: 200, body: { ok: true, notices: [], timeline: items } };
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
  // Machine availability per team alias (the Loops projection consumes it).
  const machinePresence: Record<string, string> = {};
  for (const { alias, machineId } of await store.listTeamAliases(teamId)) {
    const m = await store.getMachine(machineId);
    if (m) machinePresence[alias] = machinePresence[alias] ?? presenceOf(m.lastSeen);
  }
  return { status: 200, body: { ok: true, notices: [], snapshot, events, machinePresence } };
}

function presenceOf(lastSeen: string | null): string {
  if (!lastSeen) return "offline";
  const silentMs = Date.now() - Date.parse(lastSeen);
  if (silentMs < 30_000) return "online";
  if (silentMs < 6 * 3600_000) return "asleep";
  return "offline";
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
