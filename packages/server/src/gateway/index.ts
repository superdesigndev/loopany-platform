/**
 * Machine gateway — the HTTP surface the daemon talks to (short-poll transport).
 * Three endpoints, all framework-agnostic (return `{ status, body }` so they can
 * be mounted on a plain http server or, later, TanStack server routes):
 *
 *   POST /api/machine/poll   (Bearer device token) → claim pending runs, deliver
 *   POST /agent-api/loop     (Bearer run token)    → the `loopany` shim's verbs
 *   POST /machine/report     (Bearer run token)    → finalize a run
 *
 * Also exposes `dispatcher` (a `Dispatcher` for the Scheduler: "is the machine
 * online?") and `sweepOffline()` (mark stale machines offline). The agent-api
 * verb dispatch is a compact port of c0's control.ts: report/show + the
 * allowControl schedule mutations, plus set-ui/schema/workflow gated to the
 * evolution pass (the evolve run-token carries the canSet* caps).
 */
import { Cron } from "croner";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { CodingAgent, ControlAction, Loop, NewLoop, NotifyPolicy, RunArtifact, RunRole, RunStatus, StateField, TranscriptStep } from "../db/schema.js";
import type { Scheduler } from "../scheduler/index.js";
import { buildDelivery, type Delivery } from "./delivery.js";
import { dispatchNotification, failureMessage, shouldNotify, shouldNotifyFailure } from "./notify.js";
import { createBlobStore, type BlobStore } from "./blobstore.js";
import { maintainStorage, type MaintainResult } from "./retention.js";
import { BLOB_CAP, isIgnoredPath, isValidHash, looksBinary, safeRelPath, sha256Buf } from "./artifacts.js";
import { loopBytesCap, snapshotRetention } from "../env.js";
import {
  machineIdFromToken,
  getDeviceOwner,
  readClaimIntent,
  registerRunToken,
  resolveRunToken,
  revokeRunToken,
  fulfillClaim,
  readClaim,
  sha256,
  type ClaimResult,
  type RunSlot,
} from "./tokens.js";
import { isSuperAdmin } from "../superadmin.js";

const log = logger.child({ mod: "gateway" });

export const ONLINE_TTL_MS = 30_000;
/** A pending run no machine claims within this window is reclaimed as "machine offline". */
const PENDING_GRACE_MS = 60_000;
/** A claimed run that never reports within this window is reclaimed as timed out. */
const RUN_TIMEOUT_MS = Number(process.env.LOOPANY_RUN_TIMEOUT_MS || 20 * 60_000);
const MAX_NEXT_MS = 30 * 86_400_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_ARTIFACTS = 200;
const MAX_TRANSCRIPT_STEPS = 200;
const STEP_FIELD_MAX = 4000;
/** `loopany log`: how many recent runs to return, and the per-run transcript cap.
 *  The on-machine agent wants recent history before editing/evolving — not an
 *  unbounded dump — so default to a handful of runs and clip each transcript. */
const LOG_RUNS_DEFAULT = 8;
const LOG_RUNS_MAX = 20;
const LOG_TRANSCRIPT_CAP = 8000;

/** Validate the daemon-reported artifact list (untrusted wire input). */
function coerceArtifacts(raw: unknown): RunArtifact[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RunArtifact[] = [];
  for (const a of raw) {
    const p = (a as { path?: unknown })?.path;
    const k = (a as { kind?: unknown })?.kind;
    if (typeof p === "string" && p.trim() && (k === "created" || k === "edited")) {
      out.push({ path: p.slice(0, 1024), kind: k });
      if (out.length >= MAX_ARTIFACTS) break;
    }
  }
  return out.length ? out : undefined;
}

/** Validate the daemon-reported execution trace (untrusted wire input; re-clip defensively). */
function coerceTranscript(raw: unknown): TranscriptStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TranscriptStep[] = [];
  for (const s of raw) {
    const kind = (s as { kind?: unknown })?.kind;
    if (kind !== "text" && kind !== "tool" && kind !== "result") continue;
    const step: TranscriptStep = { kind };
    const text = (s as { text?: unknown })?.text;
    const name = (s as { name?: unknown })?.name;
    const input = (s as { input?: unknown })?.input;
    if (typeof text === "string") step.text = text.slice(0, STEP_FIELD_MAX);
    if (typeof name === "string") step.name = name.slice(0, 200);
    if (typeof input === "string") step.input = input.slice(0, STEP_FIELD_MAX);
    out.push(step);
    if (out.length >= MAX_TRANSCRIPT_STEPS) break;
  }
  return out.length ? out : undefined;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

export class MachineGateway {
  constructor(
    private readonly scheduler: Scheduler,
    /** Artifact blob byte store (R2 in prod; injectable in-memory store for tests). */
    private readonly blobStore: BlobStore = createBlobStore(),
    /** Push dispatcher — injectable (like blobStore) so tests observe notifications
     *  without a network call; defaults to the real per-channel `dispatchNotification`. */
    private readonly notify: (loop: Loop, message: string) => Promise<void> = dispatchNotification,
  ) {}

  /** In-flight latch: the maintenance pass is sequential and the first post-deploy
   *  backlog reclamation can overrun the interval, so a fresh tick skips rather than
   *  running a second pass concurrently (idempotent but wasteful + double-counts). */
  private maintenanceRunning = false;

  /**
   * Alert the user that an exec run FAILED (error / timeout / machine-offline),
   * through the loop's chosen channel, gated by the anti-spam streak policy
   * (`shouldNotifyFailure` over `store.execFailureStreak`). Evolve/edit runs are
   * internal — they never produce user-facing failure noise. Best-effort + non-
   * throwing: the run's error is already on the dashboard regardless. Call AFTER
   * the run row has been finalized to `error`, so the streak count includes it.
   */
  private notifyRunFailure(loopId: string, role: RunRole, reason: string | null): void {
    if (role !== "exec") return;
    const loop = store.getLoop(loopId);
    if (!loop) return;
    const streak = store.execFailureStreak(loopId);
    if (shouldNotifyFailure(loop.notify, streak)) {
      void this.notify(loop, failureMessage(reason));
    }
  }

  /**
   * Dispatcher for the Scheduler. Short-poll transport: a no-op — the pending
   * run row IS the queue, and the daemon's next poll claims it. (A future WS
   * gateway would push here instead.)
   */
  readonly dispatcher = {
    dispatch: (): void => {},
  };

  /**
   * Periodic maintenance: mark stale machines offline, and reclaim stuck runs —
   * a pending run no machine claimed within the grace window ("machine offline"),
   * or a claimed run that never reported ("timed out"). Best-effort delivery
   * with no inbox/catch-up, so stuck runs become errors rather than lingering.
   */
  sweep(): void {
    const now = Date.now();
    for (const m of store.listMachines()) {
      if (m.online && (!m.lastSeen || now - Date.parse(m.lastSeen) > ONLINE_TTL_MS)) {
        store.updateMachine(m.id, { online: false });
      }
    }
    for (const run of store.openRuns()) {
      const age = now - Date.parse(run.ts);
      if (run.phase === "pending") {
        // Don't kill a queued run just because its machine is busy: only reclaim
        // as "machine offline" when the machine is actually offline. An online
        // daemon claims pending runs on its next poll (seconds), so a healthy
        // machine clears the queue itself. The long fallback catches a delivery
        // that's wedged (e.g. never claimable) so it can't linger forever.
        const online = store.getMachine(run.machineId)?.online ?? false;
        if (!online && age > PENDING_GRACE_MS) {
          store.updateRun(run.id, { phase: "error", outcome: "error", error: "machine offline", ts: nowIso() });
          if (run.role === "evolve") this.scheduler.finishEvolution(run.loopId);
          this.notifyRunFailure(run.loopId, run.role, "machine offline");
        } else if (age > RUN_TIMEOUT_MS) {
          store.updateRun(run.id, { phase: "error", outcome: "error", error: "run never claimed", ts: nowIso() });
          if (run.role === "evolve") this.scheduler.finishEvolution(run.loopId);
          this.notifyRunFailure(run.loopId, run.role, "run never claimed");
        }
      } else if (run.phase === "running" && age > RUN_TIMEOUT_MS) {
        store.updateRun(run.id, { phase: "error", outcome: "error", error: "machine timed out / disconnected", ts: nowIso() });
        if (run.role === "evolve") this.scheduler.finishEvolution(run.loopId);
        this.notifyRunFailure(run.loopId, run.role, "machine timed out / disconnected");
      }
    }
  }

  /**
   * Periodic storage maintenance: prune each loop's run snapshots to the
   * retention window, then GC blob bytes no live row needs. Wired to its own
   * interval in boot (independent of the faster offline-sweep) and exposed for
   * tests / on-demand triggers. Safe to run concurrently with active syncs (a
   * grace window + final re-check protect freshly-written/referenced blobs) and
   * idempotent with no garbage. Best-effort — never throws into the caller.
   */
  async maintainStorage(): Promise<MaintainResult> {
    if (this.maintenanceRunning) {
      log.info("storage maintenance already in progress — skipping this tick");
      return { snapshotsPruned: 0, blobsReclaimed: 0 };
    }
    this.maintenanceRunning = true;
    try {
      return await maintainStorage(this.blobStore);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "storage maintenance failed");
      return { snapshotsPruned: 0, blobsReclaimed: 0 };
    } finally {
      this.maintenanceRunning = false;
    }
  }

  // ---- POST /api/machine/poll ----

  poll(
    deviceToken: string,
    info?: { host?: string; platform?: string; arch?: string },
    progress?: Array<{ runId: string; step: number; label: string }>,
  ): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    let machine = store.getMachine(machineId);
    if (!machine) {
      // Self-register: the daemon presents a valid device token (minted by New
      // loop or stored locally) — create its machine row on first contact, no
      // web-side pre-creation needed. Personal/low-security (BYOA §8).
      // Owner remembered at mint time (AI-First claim) when the gate is on;
      // "shared" otherwise (open mode, or a token minted out-of-band).
      const owner = getDeviceOwner(machineId) ?? "shared";
      // Home/default team for this machine: ALWAYS the owner's personal team (the
      // no-claim fallback for loops created on it later). A loop's actual team comes
      // from the validated claim intent at createLoop time, never from this home
      // team — so cross-team capture still lands in team B. Keeping home = personal
      // team preserves the safe invariant that a machine's fallback can never be a
      // shared team the owner is merely a (possibly later-revoked) member of.
      const teamId = store.teamIdForUser(owner);
      store.ensureTeam(teamId, owner === "shared" ? "Shared Workspace" : "Personal Team", owner === "shared" ? null : owner);
      machine = store.createMachine({
        id: machineId,
        userId: owner,
        teamId,
        // Always name it (never blank) — listMachines hides empty-name rows, so a
        // self-registered machine must carry a name to show up + be counted.
        name: info?.host || `machine-${machineId.slice(2, 8)}`,
        tokenHash: sha256(deviceToken),
        token: deviceToken,
        online: true,
      });
      log.info({ machineId, host: info?.host }, "poll: self-registered machine");
    }
    store.setMachineOnline(machineId, true); // stamps online + lastSeen (TTL) every poll
    // Identity rarely changes after the first poll — only write it when a field
    // actually differs, so the hot path (every ~3s/machine) isn't a 2nd UPDATE.
    if (info) {
      const patch = {
        ...(info.host && info.host !== machine.hostname ? { hostname: info.host } : {}),
        ...(info.platform && info.platform !== machine.platform ? { platform: info.platform } : {}),
        ...(info.arch && info.arch !== machine.arch ? { arch: info.arch } : {}),
        ...(info.host && !machine.name?.trim() ? { name: info.host } : {}),
      };
      if (Object.keys(patch).length) store.updateMachine(machineId, patch);
    }

    // Live progress for in-flight runs (slim activity line, not the transcript).
    // Scope to this machine's own running rows; a finalized row is left alone.
    if (progress?.length) {
      for (const p of progress) {
        if (typeof p?.runId !== "string" || typeof p.label !== "string") continue;
        const run = store.getRun(p.runId);
        if (run?.machineId !== machineId || run.phase !== "running") continue;
        const step = Number(p.step) || 0;
        const label = p.label.slice(0, 200);
        // Skip the write when the signal hasn't moved — claude can sit inside one
        // long tool_use across several 3s heartbeats, so most polls repeat it.
        const cur = run.progress as { step?: number; label?: string } | null;
        if (cur?.step !== step || cur?.label !== label) store.updateRun(p.runId, { progress: { step, label } });
      }
    }

    const deliveries: Delivery[] = [];
    for (const run of store.openRuns()) {
      if (run.machineId !== machineId || run.phase !== "pending") continue;
      const loop = store.getLoop(run.loopId);
      if (!loop) {
        store.updateRun(run.id, { phase: "error", outcome: "error", error: "loop removed", ts: nowIso() });
        continue;
      }
      // Edit + evolve runs exist to change the loop, so they always get control
      // AND the structural edit caps (schedule, UI, schema, workflow).
      const structural = run.role === "evolve" || run.role === "edit";
      const token = registerRunToken({
        runId: run.id,
        loopId: loop.id,
        machineId,
        role: run.role,
        allowControl: structural || loop.allowControl,
        canSetUi: structural,
        canSetSchema: structural,
        canSetWorkflow: structural,
      });
      store.updateRun(run.id, { phase: "running", ts: nowIso() });
      deliveries.push(buildDelivery(loop, run.id, token, machine.roots ?? []));
    }

    // Watch set: every loop bound to this machine (not just those with a pending
    // run) so the daemon watches each loop's folder continuously — between runs
    // and across restarts (the set is re-learned each poll, server-authoritative).
    // The daemon resolves the actual folder per loop (dirname(taskFile) → workdir).
    const watch = store.loopsForMachine(machineId).map((l) => ({
      loopId: l.id,
      workdir: l.workdir ?? null,
      taskFile: l.taskFile ?? null,
    }));

    if (deliveries.length) log.info({ machineId, exec: deliveries.length }, "poll: delivered");
    return { status: 200, body: { deliveries, watch } };
  }

  // ---- GET /api/machine/status ----

  /**
   * Whether this machine (by device token) currently has a live daemon — so
   * Claude Code can avoid starting a duplicate. `online` is fresh-checked against
   * the poll TTL, not just the stored flag.
   */
  status(deviceToken: string): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    const machine = store.getMachine(machineId);
    // Unknown token ⇒ not connected yet (the daemon self-registers on first poll),
    // so report offline rather than erroring — keeps the skill's check uniform.
    if (!machine) return { status: 200, body: { online: false, name: null, lastSeen: null } };
    const fresh = !!machine.lastSeen && Date.now() - Date.parse(machine.lastSeen) < ONLINE_TTL_MS;
    return { status: 200, body: { online: !!machine.online && fresh, name: machine.name || null, lastSeen: machine.lastSeen ?? null } };
  }

  // ---- POST /api/machine/loop ----

  /**
   * Create a loop from Claude Code (Bearer device token). The user perfected the
   * task in their own Claude Code session, then — per SKILL.md — claude authors
   * the loop config and POSTs it here. Binds the loop to the token's machine and
   * schedules it immediately. The web's New-loop dialog is just waiting on this.
   */
  createLoop(
    deviceToken: string,
    body: {
      name?: unknown;
      cron?: unknown;
      timezone?: unknown;
      task?: unknown;
      workflow?: unknown;
      workdir?: unknown;
      taskFile?: unknown;
      stateSchema?: unknown;
      notify?: unknown;
      /** Coding agent the daemon recorded as this loop's host (claude-code | codex).
       *  Absent for older daemons → defaults to claude-code. Recording-only: a codex
       *  loop is still executed via Claude for now. */
      agent?: unknown;
      /** Web's New-loop claim token — correlates this loop back to the dialog. */
      claim?: unknown;
    },
  ): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    const machine = store.getMachine(machineId);
    if (!machine) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    const cron = str(body.cron);
    if (!cron) return { status: 400, body: { error: "cron required (5-field, e.g. \"0 8 * * *\")" } };
    const cadence = validCadence(cron);
    if (!cadence.ok) return { status: 400, body: { error: `invalid cron: ${cadence.detail}` } };

    const timezone = str(body.timezone);
    if (timezone && !validTimezone(timezone)) {
      return { status: 400, body: { error: invalidTimezoneError(timezone) } };
    }

    const task = str(body.task);
    const workflow = str(body.workflow);
    if (!task && !workflow) return { status: 400, body: { error: "provide a workflow (JS) or a task (instruction)" } };

    const notify = body.notify === "always" || body.notify === "never" ? body.notify : "auto";
    // Recorded coding agent: trust the daemon's resolved value when it's a known
    // agent, else default to claude-code (older daemons omit it; an unrecognized /
    // "unknown" value also degrades to the default rather than rejecting the loop).
    const agent: CodingAgent = body.agent === "codex" ? "codex" : "claude-code";

    // Resolve the loop's TEAM. The connect-key/claim was minted under a specific
    // team's dashboard session; that bound team — not the machine's single home
    // team — decides where the loop lands. This is what lets ONE machine/daemon
    // serve MANY teams (report §2.1). With no claim intent (older daemon, CLI
    // direct path) we fall back to the machine's home team, exactly as before.
    const homeTeam = machine.teamId ?? store.teamIdForUser(machine.userId);
    let teamId = homeTeam;
    const intent = readClaimIntent(str(body.claim));
    if (intent && intent.teamId !== homeTeam) {
      // CROSS-TEAM create. SECURITY (report §4) — fail CLOSED, never silently
      // mis-file into the home team (the original bug):
      //  - bind the claim to its minter: the same human who minted it under a
      //    validated team session must be the one creating the loop;
      //  - RE-VALIDATE authorization NOW (membership can change after mint),
      //    mirroring requestScope: a current team member, or a superadmin on an
      //    existing team. The team value itself is server-minted, never client input.
      if (machine.userId !== intent.userId) {
        return { status: 403, body: { error: "connect-key was minted by a different user" } };
      }
      const authorized =
        store.isTeamMember(intent.teamId, machine.userId) ||
        (!!store.getTeam(intent.teamId) && isSuperAdmin(store.userEmail(machine.userId)));
      if (!authorized) {
        return { status: 403, body: { error: "not authorized to create loops in that team" } };
      }
      teamId = intent.teamId;
    }
    // Default to the team's most recently configured channel (listChannels is
    // newest-first) so a freshly-added Feishu/Telegram channel auto-applies to new
    // loops — computed against the RESOLVED team so it routes to that team's channel.
    const channelId = store.defaultChannelId(teamId);
    const loop = store.createLoop({
      userId: machine.userId ?? "shared",
      teamId,
      channelId,
      machineId,
      name: str(body.name),
      cron,
      timezone,
      task,
      workflow,
      workdir: str(body.workdir),
      taskFile: str(body.taskFile),
      stateSchema: store.coerceStateSchema(body.stateSchema) ?? null,
      notify,
      agent,
      enabled: true,
    });
    this.scheduler.addLoop(loop);
    // Run once immediately so a freshly-created loop produces output without
    // waiting for its first cron tick (gated on `enabled`).
    if (loop.enabled) this.scheduler.runNow(loop.id);
    const name = loop.name ?? loop.id;
    if (typeof body.claim === "string" && body.claim.trim()) {
      fulfillClaim(body.claim.trim(), { loopId: loop.id, name, machineId, agent });
    }
    log.info({ machineId, loopId: loop.id, agent }, "createLoop: created from a coding agent");
    return { status: 200, body: { ok: true, id: loop.id, name } };
  }

  // ---- GET/PATCH /api/machine/loop — the owner's interactive agent edits ----

  /** List the loops bound to this machine, for `loopany loops`. */
  listLoops(deviceToken: string): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    const loops = store.loopsForMachine(machineId).map((l) => ({
      id: l.id,
      name: l.name ?? l.id,
      cron: l.cron,
      timezone: l.timezone,
      enabled: l.enabled,
      notify: l.notify,
      nextRunAt: l.nextRunAt,
      // Folder hints so a workdir-scoped CLI (`loopany log`) can map the current
      // directory back to a loop the same way the watcher resolves it.
      workdir: l.workdir ?? null,
      taskFile: l.taskFile ?? null,
    }));
    return { status: 200, body: { ok: true, loops } };
  }

  /**
   * Recent run execution logs (transcripts) for a loop, for the on-machine agent
   * (`loopany log`). The device-facing twin of the web-only `getTranscript`:
   * authed by the SAME device token the daemon already uses, and scoped strictly
   * to a loop bound to THAT machine (`loop.machineId === machineId`, exactly like
   * `editLoop`/`sync`) — a token can never read another loop's or another device's
   * runs. Read-only. Returns the most recent N runs newest-first with each run's
   * outcome + a clipped transcript so the create/update/evolve flows can see how
   * past runs actually went before reshaping the loop.
   */
  loopLog(deviceToken: string, loopId: unknown, limit?: unknown): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (typeof loopId !== "string" || !loopId) return { status: 400, body: { error: "loopId required" } };
    const loop = store.getLoop(loopId);
    // Loop+device scoping: only a loop bound to this machine is visible. A token
    // for device A, or for a different loop, gets a flat 404 (existence never leaks).
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    const want = Number(limit);
    const n = Math.min(Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : LOG_RUNS_DEFAULT, 1), LOG_RUNS_MAX);
    // listRuns returns the newest n runs oldest-first; reverse to newest-first so
    // the agent reads the most recent history at the top.
    const rows = store.listRuns(loopId, n).slice().reverse();
    const runs = rows.map((r) => {
      const { text, truncated } = renderTranscript(r.transcript as TranscriptStep[] | null);
      return {
        id: r.id,
        ts: r.ts,
        role: r.role,
        phase: r.phase,
        outcome: r.outcome ?? null,
        status: r.status ?? null,
        durationMs: r.durationMs ?? null,
        error: r.error ?? null,
        message: r.message ?? null,
        // The claude-code session id lets the agent jump from this survey straight
        // to the run's on-disk `<session>.jsonl` for a deep dive (see evolve.md).
        sessionId: r.sessionId ?? null,
        // The metrics the run reported: the metric object (`state`) plus the
        // single-metric `sample`, so `loopany log` surfaces them alongside the
        // transcript (matches what buildEvolveTask feeds the evolve agent).
        state: r.state ?? null,
        sample: r.sample ?? null,
        transcript: text,
        transcriptTruncated: truncated,
      };
    });
    return { status: 200, body: { ok: true, loopId: loop.id, name: loop.name ?? loop.id, runs } };
  }

  /**
   * Edit a loop's scheduling envelope from the owner's interactive agent
   * (`loopany edit`). Authed by the machine's device token and scoped to loops
   * bound to THAT machine — deliberately NOT gated by allowControl (that flag
   * governs a running run rescheduling ITSELF; the human owner may always edit).
   * Task CONTENT lives in the loop's README.md on the machine, so it's edited there, not here.
   */
  editLoop(
    deviceToken: string,
    id: unknown,
    patch: {
      name?: unknown;
      cron?: unknown;
      timezone?: unknown;
      notify?: unknown;
      model?: unknown;
      allowControl?: unknown;
      taskFile?: unknown;
      enabled?: unknown;
      runAt?: unknown;
    },
  ): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (typeof id !== "string" || !id) return { status: 400, body: { error: "loop id required" } };
    const loop = store.getLoop(id);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    const p = patch ?? {};
    const update: Partial<NewLoop> = {};

    if (p.cron !== undefined) {
      const cron = str(p.cron);
      if (!cron) return { status: 400, body: { error: "cron cannot be empty" } };
      const c = validCadence(cron);
      if (!c.ok) return { status: 400, body: { error: `invalid cron: ${c.detail}` } };
      update.cron = cron;
    }
    if (p.timezone !== undefined) {
      const tz = str(p.timezone);
      if (tz && !validTimezone(tz)) return { status: 400, body: { error: invalidTimezoneError(tz) } };
      update.timezone = tz;
    }
    if (p.name !== undefined) update.name = str(p.name);
    if (p.model !== undefined) update.model = str(p.model);
    if (p.taskFile !== undefined) update.taskFile = str(p.taskFile);
    if (p.notify !== undefined) {
      const v = p.notify;
      if (v !== "always" && v !== "auto" && v !== "never") return { status: 400, body: { error: "notify must be always|auto|never" } };
      update.notify = v;
    }
    if (p.allowControl !== undefined) update.allowControl = !!p.allowControl;
    if (p.enabled !== undefined) update.enabled = !!p.enabled;
    if (p.runAt !== undefined) {
      const when = parseWhen(String(p.runAt));
      if (!when) return { status: 400, body: { error: "run-at must be 30m|2h|1d or a future ISO time" } };
      if (Date.parse(when) > Date.now() + MAX_NEXT_MS) return { status: 400, body: { error: "run-at too far in the future (>30d)" } };
      update.nextRunAt = when;
    }

    if (Object.keys(update).length === 0) return { status: 400, body: { error: "nothing to change" } };

    const updated = store.updateLoop(id, update);
    if (!updated) return { status: 404, body: { error: "loop not found" } };
    // Re-arm the scheduler: an enabled flip toggles add/remove, any other change re-adds.
    if (updated.enabled) this.scheduler.addLoop(updated);
    else this.scheduler.removeLoop(updated.id);
    log.info({ machineId, loopId: id, fields: Object.keys(update) }, "editLoop: applied");
    return { status: 200, body: { ok: true, id: updated.id, name: updated.name ?? updated.id, applied: Object.keys(update) } };
  }

  /** Read a New-loop claim's result (the web dialog polls this while waiting). */
  claimStatus(token: string): ClaimResult | undefined {
    return readClaim(token);
  }

  // ---- POST /agent-api/loop ----

  agentApi(runToken: string, argv: string[]): HttpResult {
    const slot = resolveRunToken(runToken);
    if (!slot) return { status: 401, body: { text: "loopany: invalid or expired token", exitCode: 1 } };
    const out = this.dispatch(slot, argv);
    return { status: out.code, body: { text: out.text, exitCode: out.code === 200 ? 0 : 1 } };
  }

  // ---- POST /machine/report ----

  report(
    runToken: string,
    body: {
      ok?: boolean;
      durationMs?: number;
      sessionId?: string;
      /** Files the run's claude session created/edited (transcript-derived). */
      artifacts?: Array<{ path?: unknown; kind?: unknown }>;
      /** Slimmed execution trace (text/tool/result steps) for the run-detail view. */
      transcript?: unknown;
      /** Latest content of the loop's task file (durable context+log doc). */
      taskFileContent?: unknown;
      error?: string;
      finalText?: string;
      /** "direct"/"silent" (workflow), "exec" (claude), or "evolve". Defaults by role. */
      outcome?: "direct" | "silent" | "exec" | "evolve";
      /** Workflow's direct message (set on the run). */
      message?: string;
      /** Workflow cursor (free-form) → persisted as loop.state for next run's `prev`. */
      cursor?: unknown;
    },
  ): HttpResult {
    const slot = resolveRunToken(runToken);
    if (!slot) return { status: 401, body: { error: "invalid or expired token" } };
    const ok = !!body.ok;

    // Persist the workflow cursor (free-form), if any.
    if (body.cursor !== undefined) store.updateLoop(slot.loopId, { state: body.cursor });

    // Sync the machine's task file onto the loop (untrusted wire input — clip
    // defensively even though the daemon already caps it).
    if (typeof body.taskFileContent === "string") {
      store.updateLoop(slot.loopId, {
        taskFileContent: body.taskFileContent.slice(0, 512 * 1024),
        taskFileSyncedAt: nowIso(),
      });
    }

    // Message: a workflow reports it here; a claude run already set it via the
    // agent-api `loopany report` — fall back to claude's final text only if blank.
    const run = store.getRun(slot.runId);
    // The user stopped this run while the machine was still working — keep it
    // canceled, don't let a late report flip it back to done/error.
    if (run?.phase === "canceled") {
      revokeRunToken(runToken);
      // Clear a pending edit even if its run was canceled, so it doesn't re-fire.
      if (slot.role === "edit") this.scheduler.finishEdit(slot.loopId);
      log.info({ runId: slot.runId }, "report: ignored (run was canceled)");
      return { status: 200, body: { ok: true } };
    }
    const message =
      body.message !== undefined ? body.message : !run?.message && body.finalText ? body.finalText.slice(0, 2000) : undefined;

    const artifacts = coerceArtifacts(body.artifacts);
    const transcript = coerceTranscript(body.transcript);

    // Mirror the workflow's returned cursor scalars onto THIS run, so the
    // generative UI's {{latest.*}} + the trend chart bind. A pure workflow has no
    // `loopany report --state` call (that's how exec loops set run.state), so its
    // metrics would otherwise live only in the loop cursor and never render. Don't
    // clobber a state the run already reported (e.g. a workflow that escalated).
    const runState = ok && !run?.state ? scalarState(body.cursor) : undefined;

    const finalized = store.updateRun(slot.runId, {
      phase: ok ? "done" : "error",
      outcome: ok ? body.outcome ?? (slot.role === "evolve" ? "evolve" : "exec") : "error",
      durationMs: body.durationMs ?? null,
      sessionId: body.sessionId ?? null,
      ...(artifacts ? { artifacts } : {}),
      ...(transcript ? { transcript } : {}),
      ...(runState ? { state: runState } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(ok ? {} : { error: body.error ?? "run failed on machine" }),
      progress: null, // live signal done — the full transcript supersedes it
      ts: nowIso(),
    });
    revokeRunToken(runToken);

    // Capture the loop's full file set as THIS run's snapshot (Phase 3 diff
    // baseline). Cheap: just record the manifest from the already-synced
    // artifact_files; the diff is computed lazily on read (getRunDiff), never
    // here. The daemon flushes a final run-tagged sync before reporting, so this
    // reflects the run's end-state. Best-effort — never let it fail the report.
    try {
      store.putRunSnapshot(slot.runId, slot.loopId, store.buildLoopManifest(slot.loopId));
      // Bound the snapshot history right away (cheap, keeps the table from growing
      // unbounded between maintenance passes). The blobs this unpins are reclaimed
      // by the periodic GC, not here — the grace window means a just-unreferenced
      // blob isn't collectable yet anyway, and report() must stay lean + zero-exec.
      store.pruneRunSnapshots(slot.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: slot.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
    }

    if (slot.role === "evolve") {
      this.scheduler.finishEvolution(slot.loopId);
    } else if (slot.role === "edit") {
      // Always clear the marker (done OR error) so a stuck edit can't hijack
      // every subsequent tick. The owner re-issues if it didn't take.
      this.scheduler.finishEdit(slot.loopId);
    } else if (ok) {
      this.scheduler.maybeFlagEvolve(slot.loopId);
    }

    // Notify (the loop's chosen channel), best-effort. Edit/evolve runs are
    // internal (owner config change / self-shaping) — never user-facing, success
    // OR failure. `updateRun` already returned the finalized row.
    if (slot.role !== "evolve" && slot.role !== "edit") {
      if (ok) {
        // Success: gate on the loop's notify policy + the run's content status.
        const loop = store.getLoop(slot.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          void this.notify(loop, finalized.message);
        }
      } else {
        // Failure: surface it (silent failure is the BYOA default failure mode),
        // anti-spam'd by the consecutive-failure streak so a persistently-broken
        // loop doesn't push every tick.
        this.notifyRunFailure(slot.loopId, slot.role, finalized?.error ?? null);
      }
    }
    log.info({ runId: slot.runId, ok }, "report: finalized");
    return { status: 200, body: { ok: true } };
  }

  // ---- POST /api/machine/sync ----

  /**
   * Live artifact sync (Bearer DEVICE token — the durable machine identity, NOT
   * the run token which is revoked at run end; live sync runs continuously,
   * including between runs and on idle-time human edits). The daemon posts the
   * FULL current manifest of a loop's folder plus optional inline bytes for small
   * files; the server stores verified blobs in R2, reconciles `artifact_files`
   * (vanished paths become tombstones), and replies with the hashes it still
   * needs — content-addressed dedupe means an unchanged folder uploads nothing.
   */
  async sync(
    deviceToken: string,
    body: {
      loopId?: unknown;
      runId?: unknown;
      manifest?: unknown;
      blobs?: unknown;
    },
  ): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const machine = store.getMachine(machineId);
    if (!machine) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    const loopId = typeof body.loopId === "string" ? body.loopId : "";
    if (!loopId) return { status: 400, body: { error: "loopId required" } };
    const loop = store.getLoop(loopId);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    // runId attribution (Phase 3 seam): honored only when it names a run on this loop.
    let runId: string | null = null;
    if (typeof body.runId === "string" && body.runId) {
      const run = store.getRun(body.runId);
      if (run && run.loopId === loopId) runId = body.runId;
    }

    // Verified inline bytes, indexed by hash (small files sent in the POST to skip
    // the PUT round-trip). Anything failing integrity/cap is silently dropped → it
    // simply lands in needHashes and arrives via PUT instead.
    const inline = new Map<string, Buffer>();
    if (Array.isArray(body.blobs)) {
      for (const b of body.blobs) {
        const hash = (b as { hash?: unknown }).hash;
        const data = (b as { data?: unknown }).data;
        const enc: BufferEncoding = (b as { encoding?: unknown }).encoding === "utf8" ? "utf8" : "base64";
        if (!isValidHash(hash) || typeof data !== "string") continue;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(data, enc);
        } catch {
          continue;
        }
        if (bytes.length > BLOB_CAP) continue;
        if (sha256Buf(bytes) !== hash) continue; // integrity / anti-poisoning
        inline.set(hash, bytes);
      }
    }

    const manifest = Array.isArray(body.manifest) ? body.manifest : [];
    const keepPaths: string[] = [];
    const seenPaths = new Set<string>();
    const needHashes = new Set<string>();
    const toStore = new Map<string, Buffer>();

    // Per-loop storage cap (runaway guard). We track a PROJECTED footprint as we
    // reconcile: the loop's already-stored bytes plus any NEW bytes this sync would
    // add (a file pointing at a hash the server doesn't yet have). When accepting a
    // new file would push it past the cap we reject THAT file — skip its bytes + its
    // row — so existing files and deletions still reconcile (the loop never gets
    // wedged), and surface the cap on the response (mirrors the per-file oversize
    // signal). Reusing an already-stored hash adds no bytes, so it's always allowed.
    const bytesCap = loopBytesCap();
    let projectedBytes = store.loopStoredBytes(loopId);
    const rejectedPaths: string[] = [];
    let capExceeded = false;

    for (const raw of manifest) {
      const rel = safeRelPath((raw as { path?: unknown })?.path);
      if (!rel) continue; // absolute / traversal / empty → reject
      if (isIgnoredPath(rel)) continue; // secret/junk → never store (defense in depth)
      if (seenPaths.has(rel)) continue;
      seenPaths.add(rel);

      const rawSize = Number((raw as { size?: unknown })?.size);
      const sizeOk = Number.isFinite(rawSize) && rawSize >= 0;
      const binary = !!(raw as { binary?: unknown })?.binary;
      const hash = (raw as { hash?: unknown })?.hash;
      const oversize = !!(raw as { oversize?: unknown })?.oversize || (sizeOk && rawSize > BLOB_CAP);

      if (oversize) {
        // Metadata-only: genuinely over the per-file cap (path + size, no bytes).
        store.upsertArtifactFile({
          loopId,
          path: rel,
          hash: null,
          size: sizeOk ? rawSize : null,
          binary,
          oversize: true,
          lastRunId: runId,
        });
        keepPaths.push(rel);
        continue;
      }

      if (!isValidHash(hash)) {
        // In-cap entry with a missing/invalid content hash (the real daemon never
        // sends this). We can't represent a real file without bytes, so drop it
        // entirely rather than mislabel it oversize.
        continue;
      }

      const inlined = inline.get(hash);
      // Does accepting this file add NEW bytes to storage? It doesn't if the server
      // already has the blob (global content-addressed dedupe) or we're already
      // taking it this same sync. Only NEW bytes count toward the per-loop cap.
      // Size source, conservatively: inline bytes (authoritative) → the reported
      // size → BLOB_CAP for a non-inline file with a missing/invalid size. NEVER 0:
      // a 0 estimate would let an under-reported size slip past the cap here and
      // arrive uncapped via PUT (the daemon always sends a size, so this only bites
      // a buggy/hostile client, which we want to bound, not trust). putBlob re-checks
      // against the real byte length regardless.
      const fileSize = inlined?.length ?? (sizeOk ? rawSize : BLOB_CAP);
      const addsNewBytes = !(store.blobExists(hash) || toStore.has(hash) || needHashes.has(hash));
      if (addsNewBytes) {
        // Cap only the NET growth: overwriting an existing live, byte-backed row at
        // `rel` FREES its currently-counted bytes (the upsert below replaces it), so
        // a loop regenerating one large file in place (the running-memory model)
        // never falsely trips the cap. Only genuinely new paths / size increases count.
        const prior = store.getArtifactFile(loopId, rel);
        const freed = prior && !prior.deleted && !prior.oversize && prior.hash ? (prior.size ?? 0) : 0;
        const projectedAfter = projectedBytes + fileSize - freed;
        if (projectedAfter > bytesCap) {
          // Per-loop storage cap reached → refuse THIS new file's bytes. Skip the row
          // too (never leave an artifact pointing at a blob we won't store). Existing
          // files + deletions below still reconcile, so the loop is never wedged.
          capExceeded = true;
          rejectedPaths.push(rel);
          continue;
        }
        projectedBytes = projectedAfter;
      }

      if (inlined) toStore.set(hash, inlined);
      else if (!store.blobExists(hash)) needHashes.add(hash);

      store.upsertArtifactFile({
        loopId,
        path: rel,
        hash,
        size: sizeOk ? rawSize : (inlined?.length ?? null),
        binary: binary || (inlined ? looksBinary(inlined) : false),
        oversize: false,
        lastRunId: runId,
      });
      keepPaths.push(rel);
    }

    // Persist the inline blobs (bytes-first, then metadata row).
    for (const [hash, bytes] of toStore) {
      await this.blobStore.put(hash, bytes);
      store.recordBlob(hash, bytes.length, looksBinary(bytes));
    }

    // Deletions = absence from the full manifest → tombstone the vanished paths.
    // Cap-rejected paths are NOT tombstoned: keep their prior row (the last accepted
    // version) intact rather than dropping the file just because new bytes were
    // refused — so they're added to the keep set for the deletion reconciliation.
    const tombstoned = store.tombstoneMissingArtifacts(loopId, [...keepPaths, ...rejectedPaths], runId);

    log.info(
      { machineId, loopId, files: keepPaths.length, inlined: toStore.size, need: needHashes.size, tombstoned, rejected: rejectedPaths.length },
      "sync: reconciled",
    );
    if (capExceeded) {
      log.warn({ machineId, loopId, used: projectedBytes, cap: bytesCap, rejected: rejectedPaths.length }, "sync: per-loop storage cap reached");
    }
    return {
      status: 200,
      body: {
        ok: true,
        needHashes: [...needHashes],
        // Storage-cap signal (mirrors the per-file oversize path): when set, the
        // daemon learns its newest bytes were refused and the loop is at capacity.
        ...(capExceeded
          ? { capExceeded: true, bytesUsed: projectedBytes, bytesCap, rejected: rejectedPaths }
          : {}),
      },
    };
  }

  // ---- PUT /api/machine/blob/:hash ----

  /**
   * Upload one content-addressed blob's raw bytes (Bearer device token). The
   * server recomputes sha256(body) and rejects any mismatch before storing —
   * integrity + anti-poisoning, so a blob's bytes always match its key.
   */
  async putBlob(deviceToken: string, hash: string, bytes: Buffer): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (!isValidHash(hash)) return { status: 400, body: { error: "invalid hash (expect sha256 hex)" } };
    if (bytes.length > BLOB_CAP) return { status: 413, body: { error: "blob exceeds size cap" } };
    if (sha256Buf(bytes) !== hash) return { status: 400, body: { error: "hash mismatch (sha256(body) !== :hash)" } };

    // Per-loop storage cap, authoritative re-check (defense in depth). sync() caps
    // from the daemon-reported size; a NEW blob (one the server doesn't already
    // have) arriving here is re-measured against its REAL byte length for every
    // loop that already references the hash (the rows a prior sync wrote when it
    // returned this hash in needHashes). If storing would push a referencing loop
    // past its cap, refuse the bytes AND drop that loop's dangling rows so nothing
    // points at a blob we won't store — a later sync re-reconciles (self-healing).
    if (!store.blobExists(hash)) {
      const cap = loopBytesCap();
      const overLoops = store
        .loopsReferencingHash(hash)
        .filter((loopId) => store.loopStoredBytesExcludingHash(loopId, hash) + bytes.length > cap);
      if (overLoops.length) {
        for (const loopId of overLoops) store.dropArtifactFilesForHash(loopId, hash);
        log.warn({ machineId, hash, bytes: bytes.length, loops: overLoops.length }, "putBlob: per-loop storage cap reached — refused");
        return { status: 413, body: { error: "blob would exceed per-loop storage cap", capExceeded: true } };
      }
    }

    await this.blobStore.put(hash, bytes);
    store.recordBlob(hash, bytes.length, looksBinary(bytes));
    return { status: 200, body: { ok: true } };
  }

  /** Read a stored blob's bytes (Phase 2 download seam; null when absent). */
  readBlob(hash: string): Promise<Buffer | null> {
    if (!isValidHash(hash)) return Promise.resolve(null);
    return this.blobStore.get(hash);
  }

  // ---- agent-api verb dispatch (compact port of control.ts) ----

  private dispatch(slot: RunSlot, argv: string[]): { code: number; text: string } {
    const verb = argv[0];
    const flags = parseFlags(argv.slice(1));
    const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

    switch (verb) {
      case undefined:
      case "":
      case "-h":
      case "--help":
      case "help":
        return { code: 200, text: this.helpText(slot) };
      case "report": {
        const rawState = str("state") ?? str("state-content");
        let state: Record<string, number | string> | undefined;
        if (rawState !== undefined) {
          const loop = store.getLoop(slot.loopId);
          const v = validateState(rawState, loop?.stateSchema ?? undefined);
          if (!v.ok) return { code: 400, text: `loopany: ${v.error}` };
          state = v.value;
        }
        const status = str("status");
        store.updateRun(slot.runId, {
          ...(isStatus(status) ? { status } : {}),
          ...(str("message") !== undefined ? { message: str("message") } : {}),
          ...(str("sample") !== undefined ? { sample: Number(str("sample")) } : {}),
          ...(state !== undefined ? { state } : {}),
        });
        return { code: 200, text: "reported" };
      }
      case "show":
        return { code: 200, text: this.describe(slot.loopId, slot.allowControl) };
      case "set-ui": {
        if (!slot.canSetUi) return { code: 403, text: "loopany: only the evolution or edit pass may set the UI" };
        const html = str("body") ?? str("file-content");
        if (html === undefined) return { code: 400, text: "loopany: set-ui needs --file <path> (shim inlines it)" };
        const r = this.applySetUi(slot.loopId, html);
        this.audit(slot, "set-ui", { bytes: String(html.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "ui updated" } : { code: 400, text: `loopany: ${r.detail ?? "rejected"}` };
      }
      case "set-schema": {
        if (!slot.canSetSchema) return { code: 403, text: "loopany: only the evolution or edit pass may set the schema" };
        const json = str("body") ?? str("file-content");
        if (json === undefined) return { code: 400, text: "loopany: set-schema needs --file <path> (a JSON array of {key,label,unit})" };
        const r = this.applySetSchema(slot.loopId, json);
        this.audit(slot, "set-schema", { bytes: String(json.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "schema updated" } : { code: 400, text: `loopany: ${r.detail ?? "rejected"}` };
      }
      case "set-workflow": {
        if (!slot.canSetWorkflow) return { code: 403, text: "loopany: only the evolution or edit pass may set the workflow" };
        const body = str("body") ?? str("file-content");
        if (!body) return { code: 400, text: "loopany: set-workflow needs --file <path> (shim inlines it)" };
        const r = this.applySetWorkflow(slot.loopId, body);
        this.audit(slot, "set-workflow", { bytes: String(body.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "workflow updated" } : { code: 400, text: `loopany: ${r.detail ?? "rejected"}` };
      }
    }

    if (MUTATION_VERBS.has(verb ?? "")) {
      if (!slot.allowControl) return { code: 403, text: "loopany: this loop may not change its own schedule (allowControl is off)" };
      const r = this.applyMutation(slot.loopId, verb!, flags, str);
      this.audit(slot, verb!, stringifyFlags(flags), r);
      return r.ok ? { code: 200, text: r.detail ?? `${verb} applied` } : { code: 400, text: `loopany: ${r.detail ?? "rejected"}` };
    }
    return { code: 400, text: `loopany: unknown command "${verb ?? ""}" (try: loopany help)` };
  }

  /** Usage for `loopany help` / `--help` / a bare invocation. Role-aware: marks
   *  the structural + control groups by whether THIS run may actually use them,
   *  so the agent doesn't waste a turn probing a verb it'll be 403'd on. */
  private helpText(slot: RunSlot): string {
    const structural = slot.canSetUi ? "available to this run" : `evolve/edit pass only — this run is "${slot.role}"`;
    const control = slot.allowControl ? "available to this run" : "needs allowControl (off for this loop)";
    return [
      "loopany — in-run agent CLI. Verbs:",
      "",
      "always available:",
      "  report [--status new|resolved|nothing-new] [--message <s>] [--sample <n>] [--state '{\"k\":n}' | --state-file <p>]",
      "          record this run's outcome + metrics (keys must match the loop's schema)",
      "  show    print this loop's current config + recent state",
      "",
      `dashboard / gate (${structural}):`,
      "  set-ui --file <path>        replace the dashboard HTML",
      "  set-schema --file <path>    declare metrics — a JSON array of {key, label?, unit?}",
      "  set-workflow --file <path>  replace the deterministic pre-stage JS",
      "",
      `schedule control (${control}):`,
      '  reschedule --run-at <when> · set-cron "<expr>" · pause · resume',
      "  notify always|auto|never · set-name <s> · set-tz <z> · set-model <m>",
      "",
      "every set-* takes --file <path> (the shim inlines it); bare/inline values are rejected.",
    ].join("\n");
  }

  private applyMutation(loopId: string, verb: string, flags: Flags, str: (k: string) => string | undefined): Applied {
    switch (verb) {
      case "reschedule": {
        const next = str("next");
        const when = next ? parseWhen(next) : undefined;
        if (!when) return { ok: false, detail: `reschedule needs --next <30m|2h|ISO>` };
        if (Date.parse(when) > Date.now() + MAX_NEXT_MS) return { ok: false, detail: "too far in the future (>30d)" };
        const loop = store.updateLoop(loopId, { nextRunAt: when });
        if (loop) this.scheduler.addLoop(loop);
        return { ok: true, detail: `next run at ${new Date(when).toLocaleString()}` };
      }
      case "set-cron": {
        const cron = str("_") ?? str("cron");
        if (!cron) return { ok: false, detail: 'set-cron needs the expression, e.g. set-cron "*/30 * * * *"' };
        const c = validCadence(cron);
        if (!c.ok) return c;
        const loop = store.updateLoop(loopId, { cron });
        if (loop) this.scheduler.addLoop(loop);
        return { ok: true, detail: `cron set to "${cron}"` };
      }
      case "pause":
      case "resume": {
        const enabled = verb === "resume";
        const loop = store.updateLoop(loopId, { enabled });
        if (loop) enabled ? this.scheduler.addLoop(loop) : this.scheduler.removeLoop(loopId);
        return { ok: true, detail: enabled ? "resumed" : "paused" };
      }
      case "notify": {
        const v = (str("_") ?? str("notify")) as NotifyPolicy | undefined;
        if (v !== "always" && v !== "auto" && v !== "never") return { ok: false, detail: "notify needs always|auto|never" };
        store.updateLoop(loopId, { notify: v });
        return { ok: true, detail: `notify set to ${v}` };
      }
      case "set-name": {
        const name = (str("_") ?? str("name"))?.trim() || null;
        store.updateLoop(loopId, { name });
        return { ok: true, detail: name ? `name set to "${name}"` : "name cleared" };
      }
      case "set-tz": {
        const tz = (str("_") ?? str("tz") ?? str("timezone"))?.trim() || null;
        if (tz && !validTimezone(tz)) return { ok: false, detail: invalidTimezoneError(tz) };
        const loop = store.updateLoop(loopId, { timezone: tz });
        if (loop) this.scheduler.addLoop(loop); // tz changes the cron's interpretation
        return { ok: true, detail: tz ? `timezone set to ${tz}` : "timezone cleared (server-local)" };
      }
      case "set-model": {
        const model = (str("_") ?? str("model"))?.trim() || null;
        store.updateLoop(loopId, { model });
        return { ok: true, detail: model ? `model set to ${model}` : "model cleared" };
      }
      default:
        return { ok: false, detail: `unhandled verb ${verb}` };
    }
  }

  private applySetUi(loopId: string, html: string): Applied {
    const ui = store.coerceUi(html) ?? null;
    const loop = store.updateLoop(loopId, { ui });
    if (!loop) return { ok: false, detail: "loop not found" };
    return { ok: true, detail: ui ? `ui updated (${ui.length} bytes)` : "ui cleared" };
  }

  private applySetWorkflow(loopId: string, body: string): Applied {
    const loop = store.updateLoop(loopId, { workflow: body.trim() || null });
    if (!loop) return { ok: false, detail: "loop not found" };
    return { ok: true, detail: loop.workflow ? `workflow updated (${loop.workflow.length} bytes)` : "workflow cleared" };
  }

  private applySetSchema(loopId: string, json: string): Applied {
    const loop = store.getLoop(loopId);
    if (!loop) return { ok: false, detail: "loop not found" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, detail: 'schema must be JSON, e.g. [{"key":"mrr","label":"MRR","unit":"$"}]' };
    }
    const schema = store.coerceStateSchema(parsed);
    if (!schema) return { ok: false, detail: "schema must be a non-empty array of {key, label?, unit?}" };
    const have = new Set(schema.map((f) => f.key));
    const dropped = schemaKeysInUse(loopId).filter((k) => !have.has(k));
    if (dropped.length) {
      return {
        ok: false,
        detail: `schema changes are additive — keep keys still in use: ${dropped.join(", ")} (bound by the UI or reported by recent runs).`,
      };
    }
    store.updateLoop(loopId, { stateSchema: schema });
    return { ok: true, detail: `schema set (${schema.map((f) => f.key).join(", ")})` };
  }

  // `allowControl` is the EFFECTIVE self-schedule capability of the run calling
  // `show` (the run slot's `structural || loop.allowControl`), not just the loop
  // flag — so an evolve/edit pass reads as allowed while a normal exec run reflects
  // the loop's flag. The standing exec prompt's §4 tells the run to consult this line
  // before attempting reschedule/set-cron. Undefined ⇒ omit the line (non-run callers).
  private describe(loopId: string, allowControl?: boolean): string {
    const loop = store.getLoop(loopId);
    if (!loop) return "loop not found";
    let next = "?";
    try {
      const probe = new Cron(loop.cron, { paused: true });
      next = probe.nextRun()?.toLocaleString() ?? "(never)";
      probe.stop();
    } catch {
      next = "(invalid cron)";
    }
    const lines = [
      `cron: ${loop.cron} (next ${next})`,
      `nextRunAt: ${loop.nextRunAt ?? "—"}`,
      `enabled: ${loop.enabled}`,
      `notify: ${loop.notify}`,
    ];
    if (allowControl !== undefined) lines.push(`self-schedule: ${allowControl ? "allowed" : "off"}`);
    return lines.join("\n");
  }

  private audit(slot: RunSlot, command: string, args: Record<string, string>, r: Applied): void {
    const run = store.getRun(slot.runId);
    const control: ControlAction[] = [
      ...((run?.control as ControlAction[] | null | undefined) ?? []),
      {
        ts: nowIso(),
        command,
        args,
        result: r.ok ? "ok" : "rejected",
        detail: r.detail,
      },
    ];
    store.updateRun(slot.runId, { control });
  }
}

// ---- helpers (ported from control.ts) ----

interface Applied {
  ok: boolean;
  detail?: string;
}
type Flags = Record<string, string | boolean>;

const MUTATION_VERBS = new Set(["reschedule", "set-cron", "pause", "resume", "notify", "set-name", "set-tz", "set-model"]);

function stringifyFlags(flags: Flags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(flags)) out[k] = String(v);
  return out;
}

function schemaKeysInUse(loopId: string): string[] {
  const keys = new Set<string>();
  const loop = store.getLoop(loopId);
  if (loop?.ui) {
    for (const m of loop.ui.matchAll(/\{\{\s*(?:latest|state)\.([a-zA-Z0-9_-]+)[^}]*\}\}/g)) keys.add(m[1]!);
    for (const m of loop.ui.matchAll(/(?:series|key)=["']([^"']+)["']/g)) {
      for (const part of m[1]!.split(",")) {
        const key = part.trim().split(":")[0]?.trim();
        if (key) keys.add(key);
      }
    }
  }
  for (const run of store.listRuns(loopId, 100)) {
    if (!run.state || typeof run.state !== "object") continue;
    for (const key of Object.keys(run.state as Record<string, unknown>)) keys.add(key);
  }
  return [...keys];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Flatten a run's slimmed transcript steps into plain text for `loopany log`,
 *  clipped to LOG_TRANSCRIPT_CAP (the agent wants recent history, not a dump).
 *  Tool steps render as `$ <name> <input>`; text/result steps as their text. */
function renderTranscript(steps: TranscriptStep[] | null | undefined): { text: string; truncated: boolean } {
  if (!Array.isArray(steps) || steps.length === 0) return { text: "", truncated: false };
  const lines: string[] = [];
  for (const s of steps) {
    if (s.kind === "tool") {
      lines.push(`$ ${s.name ?? "tool"}${s.input ? ` ${s.input}` : ""}`);
    } else if (typeof s.text === "string" && s.text) {
      lines.push(s.text);
    }
  }
  const joined = lines.join("\n\n");
  if (joined.length > LOG_TRANSCRIPT_CAP) return { text: joined.slice(0, LOG_TRANSCRIPT_CAP), truncated: true };
  return { text: joined, truncated: false };
}

/** Scalar (number/string) fields of a workflow's returned cursor — the run's
 *  chartable + bindable snapshot. Drops objects/arrays/booleans/null/non-finite. */
function scalarState(cursor: unknown): Record<string, number | string> | undefined {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(cursor as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function isStatus(s: string | undefined): s is RunStatus {
  return s === "new" || s === "resolved" || s === "nothing-new";
}

/** Trim a value to a non-empty string, or null. Shared by createLoop/editLoop. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The one user-facing message for a rejected timezone, shared by every write path. */
function invalidTimezoneError(tz: string): string {
  return `invalid timezone: ${tz} (use an IANA name e.g. "Asia/Shanghai")`;
}

function validCadence(cron: string): Applied {
  try {
    const c = new Cron(cron, { paused: true });
    const a = c.nextRun();
    const b = a ? c.nextRun(a) : null;
    c.stop();
    if (!a || !b) return { ok: false, detail: "cron never fires twice" };
    if (b.getTime() - a.getTime() < MIN_INTERVAL_MS) return { ok: false, detail: "interval too dense (min 1/min)" };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse `--next` into an ISO string: relative `30m`/`2h`/`1d` or an absolute ISO. */
export function parseWhen(s: string): string | undefined {
  const rel = s.match(/^(\d+)\s*(m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    return new Date(Date.now() + ms).toISOString();
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t) && t > Date.now()) return new Date(t).toISOString();
  return undefined;
}

function validateState(
  raw: string,
  schema?: StateField[],
): { ok: true; value: Record<string, number | string> } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "--state must be a JSON object, e.g. --state '{\"mrr\":9160}'" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "--state must be a JSON object" };
  const allowed = schema?.length ? new Set(schema.map((f) => f.key)) : null;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (allowed && !allowed.has(k)) return { ok: false, error: `--state has unknown key "${k}". Allowed: ${[...allowed].join(", ")}` };
    // Finite number (chart point) or non-empty string (the UI binds it; chart ignores)
    // — same contract as the widened run.state column + the workflow mirror path.
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && v) out[k] = v;
    else return { ok: false, error: `--state.${k} must be a finite number or a non-empty string` };
  }
  return { ok: true, value: out };
}

/** Tiny flag parser: `--k v` pairs, bare `--flag` → true, first positional under `_`. */
function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else if (out["_"] === undefined) {
      out["_"] = a;
    }
  }
  return out;
}
