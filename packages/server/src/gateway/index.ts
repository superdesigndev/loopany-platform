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
import type { CodingAgent, ControlAction, Loop, NewLoop, NotifyPolicy, Run, RunArtifact, RunRole, RunStatus, RunUsage, StateField, TranscriptStep } from "../db/schema.js";
import type { Scheduler } from "../scheduler/index.js";
import { buildDelivery, type Delivery } from "./delivery.js";
import { completionMessage, dispatchNotification, failureMessage, shouldNotify, shouldNotifyFailure } from "./notify.js";
import { createBlobStore, type BlobStore } from "./blobstore.js";
import { maintainStorage, type MaintainResult } from "./retention.js";
import { BLOB_CAP, isIgnoredPath, isValidHash, looksBinary, safeRelPath, sha256Buf } from "./artifacts.js";
import { artifactMeta } from "../server/frontmatter.js";
import { pickTaskPath } from "../lib/fileEntries.js";
import { loopBytesCap, selfCronFloorMinutes, selfRescheduleFloorMinutes, snapshotRetention } from "../env.js";
import {
  machineIdFromToken,
  getDeviceOwner,
  readClaimIntent,
  registerRunLease,
  resolveLease,
  retireLease,
  terminalizeLease,
  pruneExpiredLeases,
  fulfillClaim,
  readClaim,
  readNewIdempotency,
  recordNewIdempotency,
  sha256,
  type ClaimResult,
  type RunLease,
} from "./tokens.js";
import { isSuperAdmin } from "../superadmin.js";
import {
  ABSENT,
  codeForStatus,
  countLine,
  detailBlock,
  doc,
  emptyList,
  errorBlock,
  helpBlock,
  inlineArray,
  kvLine,
  listBlock,
  scalar,
  truncate,
  type Scalar,
} from "./toon.js";

const log = logger.child({ mod: "gateway" });

export const ONLINE_TTL_MS = 30_000;
/** A pending run no machine claims within this window is reclaimed as "machine offline". */
const PENDING_GRACE_MS = 60_000;
/** A claimed run that never reports within this window is reclaimed as timed out. */
const RUN_TIMEOUT_MS = Number(process.env.LOOPANY_RUN_TIMEOUT_MS || 20 * 60_000);
const MAX_NEXT_MS = 30 * 86_400_000;
/** The ONLY keys an owner `editLoop` patch may touch. A key outside this set is
 *  rejected (400) rather than silently ignored, so a `--json` typo fails loudly
 *  and identity/ownership columns (id/teamId/userId/machineId/timestamps) can
 *  never be patched over the device-token edit surface. */
const EDITABLE_LOOP_FIELDS = new Set([
  "name",
  "cron",
  "timezone",
  "notify",
  "model",
  "allowControl",
  "taskFile",
  "enabled",
  "runAt",
  "workflow",
  "ui",
  "stateSchema",
  "goal",
]);
const MIN_INTERVAL_MS = 60_000;
const MAX_ARTIFACTS = 200;
const MAX_TRANSCRIPT_STEPS = 200;
const STEP_FIELD_MAX = 4000;
/** Cap for free-text wire fields (task / workflow / taskFileContent) — one shared
 *  clipping discipline for every large string the daemon can send. */
const WIRE_TEXT_CAP = 512 * 1024;
/** A workflow cursor bigger than this (serialized) is ignored rather than persisted
 *  onto the loop row — the run itself still records normally. */
const CURSOR_CAP = 256 * 1024;
/** Run messages (report --message / workflow direct message / finalText fallback).
 *  Run errors share the same cap. */
const MESSAGE_CAP = 2000;
/** A claude-code session id is a UUID-ish token — anything longer is garbage. */
const SESSION_ID_CAP = 200;
/** A loop's goal (setpoint) is a one-line, checkable statement — clip generously
 *  but keep it a single line's worth (not a document). Shared by createLoop/editLoop. */
const GOAL_CAP = 2000;
/** A poll heartbeat legitimately carries one progress entry per in-flight run on the
 *  machine; anything past a generous cap is garbage — process at most this many. */
const MAX_PROGRESS_ENTRIES = 32;
/** How often the persisted progress freshness stamp (`at`) refreshes while the
 *  step/label signal itself hasn't moved — throttled so the ~3s poll hot path isn't
 *  a per-heartbeat UPDATE, but the sweep still sees minute-fresh activity. */
const PROGRESS_STAMP_REFRESH_MS = 60_000;
/** The run outcomes a report may claim (untrusted wire input; anything else falls
 *  back to the role default). Mirrors the runs.outcome enum minus "error", which
 *  only the server assigns. */
const RUN_OUTCOMES = new Set(["direct", "silent", "exec", "evolve"]);

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

/** Sanity ceilings on the daemon-reported cost figures (untrusted wire input) —
 *  a single run costing more than this is a lie or a parser bug, not a bill. */
const COST_USD_MAX = 10_000;
const COST_TOKENS_MAX = 1e12;

/** Validate the daemon-reported cost/usage (untrusted wire input): finite
 *  non-negative numbers only, capped. Returns the run-row patch fields. */
function coerceCost(raw: unknown): { costUsd?: number; usage?: RunUsage } {
  if (!raw || typeof raw !== "object") return {};
  const c = raw as Record<string, unknown>;
  const num = (v: unknown, max: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
  const usage: RunUsage = {};
  const tok = (k: keyof RunUsage, v: unknown) => {
    const n = num(v, COST_TOKENS_MAX);
    if (n !== undefined) usage[k] = n;
  };
  tok("inputTokens", c.inputTokens);
  tok("outputTokens", c.outputTokens);
  tok("cacheReadTokens", c.cacheReadTokens);
  tok("cacheCreationTokens", c.cacheCreationTokens);
  tok("numTurns", c.numTurns);
  const costUsd = num(c.usd, COST_USD_MAX);
  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
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
          this.reclaimRun(run, "machine offline");
        } else if (age > RUN_TIMEOUT_MS) {
          this.reclaimRun(run, "run never claimed");
        }
      } else if (run.phase === "running") {
        // INACTIVITY-based timeout, not since-claim: a healthy run keeps its
        // progress freshness stamp (`at`) alive via the daemon's poll heartbeat,
        // so a legitimate >20min run is never falsely failed (then push-alerted,
        // then flipped back to done by its real report). Only when NOTHING has
        // been heard for the full window — no progress stamp since the claim —
        // is the machine considered gone. Runs from older daemons (no stamp)
        // degrade to the previous claim-age behavior.
        const at = run.progress?.at;
        const heardAt = Math.max(Date.parse(run.ts), at ? Date.parse(at) || 0 : 0);
        if (now - heardAt > RUN_TIMEOUT_MS) {
          this.reclaimRun(run, "machine timed out / disconnected");
        }
      }
    }
    // Drop terminal-grace leases whose wake-report window has elapsed (bounded memory).
    pruneExpiredLeases(now);
  }

  /** Finalize one stuck run as an error (the sweep's reclaim path): persist the
   *  failure, TERMINALIZE its run lease (flip it to `terminal-grace` rather than
   *  retiring it outright), clear an evolve marker, and surface the failure through
   *  the anti-spam'd notify path.
   *
   *  Why terminalize, not retire: the usual cause is a laptop that merely fell
   *  ASLEEP mid-run. When it wakes, claude finishes and the daemon delivers the real
   *  (often SUCCESSFUL) result. Retiring the lease here would 401 that late report
   *  and strand the run as a permanent false failure with its message lost (the
   *  investigated bug). So the lease survives a bounded grace window
   *  (`TERMINAL_GRACE_MS`) during which exactly ONE late wake-report may reconcile
   *  the run — see `report()`'s terminal-grace branch. The credential is still
   *  bounded: agent-api mutations are refused while terminal-grace, and the
   *  reconciliation retires the lease single-shot. A pending run (no lease minted
   *  yet) is unaffected — the terminalize is a no-op there. */
  private reclaimRun(run: Run, reason: string): void {
    store.updateRun(run.id, { phase: "error", outcome: "error", error: reason, ts: nowIso() });
    terminalizeLease(run.id);
    if (run.role === "evolve") this.scheduler.finishEvolution(run.loopId);
    this.notifyRunFailure(run.loopId, run.role, reason);
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
    info?: { host?: string; platform?: string; arch?: string; version?: string },
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
      // Untrusted wire input: a version is a short semver, so clip defensively.
      const version = typeof info.version === "string" ? info.version.slice(0, 64) : undefined;
      const patch = {
        ...(info.host && info.host !== machine.hostname ? { hostname: info.host } : {}),
        ...(info.platform && info.platform !== machine.platform ? { platform: info.platform } : {}),
        ...(info.arch && info.arch !== machine.arch ? { arch: info.arch } : {}),
        ...(version && version !== machine.daemonVersion ? { daemonVersion: version } : {}),
        ...(info.host && !machine.name?.trim() ? { name: info.host } : {}),
      };
      if (Object.keys(patch).length) store.updateMachine(machineId, patch);
    }

    // Live progress for in-flight runs (slim activity line, not the transcript).
    // Scope to this machine's own running rows; a finalized row is left alone.
    // Untrusted wire input: one entry per in-flight run is the legitimate shape,
    // so anything past the cap is garbage — process at most MAX_PROGRESS_ENTRIES.
    if (progress?.length) {
      for (const p of progress.slice(0, MAX_PROGRESS_ENTRIES)) {
        if (typeof p?.runId !== "string" || typeof p.label !== "string") continue;
        const run = store.getRun(p.runId);
        if (run?.machineId !== machineId || run.phase !== "running") continue;
        const step = Number(p.step) || 0;
        const label = p.label.slice(0, 200);
        // Skip the write when the signal hasn't moved — claude can sit inside one
        // long tool_use across several 3s heartbeats, so most polls repeat it. The
        // freshness stamp (`at`, the sweep's inactivity signal) still refreshes,
        // throttled to once a minute so the hot path isn't a per-poll UPDATE.
        const cur = run.progress;
        const moved = cur?.step !== step || cur?.label !== label;
        const stampStale = !cur?.at || Date.now() - Date.parse(cur.at) > PROGRESS_STAMP_REFRESH_MS;
        if (moved || stampStale) {
          store.updateRun(p.runId, { progress: { step, label, at: nowIso() } });
        }
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
      const token = registerRunLease({
        runId: run.id,
        loopId: loop.id,
        machineId,
        role: run.role,
        allowControl: structural || loop.allowControl,
        canSetUi: structural,
        canSetSchema: structural,
        canSetWorkflow: structural,
        // Only an EXEC run on a CLOSED loop (goal set) may finish it — independent
        // of allowControl (like the structural caps). Evolve/edit never finish.
        canFinish: run.role === "exec" && loop.goal != null,
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
      workflow?: unknown;
      workdir?: unknown;
      taskFile?: unknown;
      stateSchema?: unknown;
      /** Optional initial dashboard UI (small HTML, same surface as `set-ui`). Lets a
       *  template-driven loop ship a day-one dashboard instead of waiting for an
       *  evolve pass. Validated by the same `validateUi` editLoop uses. */
      ui?: unknown;
      notify?: unknown;
      /** Optional closed-loop setpoint. Non-null ⇒ the loop is CLOSED (self-finishes
       *  when met); null/absent ⇒ OPEN (monitor/digest). */
      goal?: unknown;
      /** Coding agent the daemon recorded as this loop's host (claude-code | codex).
       *  Absent for older daemons → defaults to claude-code. Recording-only: a codex
       *  loop is still executed via Claude for now. */
      agent?: unknown;
      /** Web's New-loop claim token — correlates this loop back to the dialog. */
      claim?: unknown;
      /** Validate-only (`loopany new --dry-run`): run every check, persist NOTHING,
       *  and return the normalized config + fire preview. Zero-exec preserved. */
      dryRun?: unknown;
      /** Content-hash idempotency key the daemon derives (sha256 over machine id +
       *  canonical config, §8.1). A retry with a still-live key returns the loop it
       *  first created instead of a twin (F8). Absent ⇒ no dedupe (old daemon). */
      idempotencyKey?: unknown;
    },
  ): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    const machine = store.getMachine(machineId);
    if (!machine) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    const cron = str(body.cron);
    if (!cron) return { status: 400, body: { error: "cron required (5-field, e.g. \"0 8 * * *\")" } };
    // Timezone first: the cadence is validated IN the loop's timezone (a cron's
    // fire times shift with it), so the tz must be known-good before the probe.
    const timezone = str(body.timezone);
    if (timezone && !validTimezone(timezone)) {
      return { status: 400, body: { error: invalidTimezoneError(timezone) } };
    }
    const cadence = validCadence(cron, timezone);
    if (!cadence.ok) return { status: 400, body: { error: `invalid cron: ${cadence.detail}` } };

    // Untrusted wire input — clip the free-text fields defensively (same
    // discipline as taskFileContent on report). The `task` column is GONE (batch 2):
    // a loop's standing brief lives in its task file's Spec, and the run message is the
    // server-composed exec CORE (see buildExecTask). So a loop needs either a
    // deterministic workflow OR a task file to work from.
    // Parse-check the workflow at write time (zero-exec) so a syntactically
    // broken body — most often the Claude Code Workflow tool's `export const
    // meta = {…}` header, which is an ES-module construct illegal in the
    // runner's async-arrow wrapper — is rejected here with a fix-teaching
    // message instead of failing every run. This also surfaces via `--dry-run`
    // (the branch below runs only after this check passes).
    const wf = this.validateWorkflow(str(body.workflow)?.slice(0, WIRE_TEXT_CAP) ?? "");
    if (!wf.ok) return { status: 400, body: { error: wf.detail } };
    const workflow = wf.value;
    const taskFile = str(body.taskFile);
    if (!workflow && !taskFile) return { status: 400, body: { error: "provide a workflow (JS) or a taskFile (path to the loop's Spec)" } };
    // Optional setpoint (clipped one-liner); absent/blank ⇒ open loop.
    const goal = str(body.goal)?.slice(0, GOAL_CAP) ?? null;

    const notify = body.notify === "always" || body.notify === "never" ? body.notify : "auto";
    // Recorded coding agent: trust the daemon's resolved value when it's a known
    // agent, else default to claude-code (older daemons omit it; an unrecognized /
    // "unknown" value also degrades to the default rather than rejecting the loop).
    const agent: CodingAgent = body.agent === "codex" ? "codex" : "claude-code";

    const stateSchema = store.coerceStateSchema(body.stateSchema) ?? null;
    // Optional day-one dashboard — same validate/clip surface as `set-ui` (editLoop).
    // Sanitized to the allowed tags/attrs; an unusable value coerces to null.
    const ui = this.validateUi(str(body.ui)?.slice(0, WIRE_TEXT_CAP) ?? "").value;
    // A dashboard the caller PROVIDED but that validated to nothing must never vanish
    // silently — surface it (dry-run + real create) so a dropped dashboard is LOUD.
    // The create still succeeds; the loop just has no dashboard until it's fixed.
    const uiDropped = body.ui != null && body.ui !== "" && ui == null;
    const uiWarning = uiDropped
      ? "the provided ui was empty after validation and was NOT applied — the loop was created without a dashboard"
      : undefined;

    // Validate-only (`loopany new --dry-run`): every check above has passed, so
    // return the normalized config + fire preview + open/closed classification and
    // persist NOTHING (no store write, no scheduler, no team-auth side effects).
    if (body.dryRun === true) {
      const config = {
        name: str(body.name),
        cron,
        timezone: timezone ?? null,
        taskFile: taskFile ?? null,
        workdir: str(body.workdir) ?? null,
        // The workflow JS body can be large — report presence, not the source.
        workflow: workflow != null,
        // Ditto for the dashboard HTML — presence flag, not the markup.
        ui: ui != null,
        goal,
        notify,
        agent,
        stateSchema,
      };
      const nextRuns = nextFires(cron, timezone, 3);
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          config,
          timezone: timezone ?? null,
          nextRuns,
          classification: goal != null ? "closed" : "open",
          classificationText:
            goal != null
              ? "closed (has goal): will self-finish when the goal is met"
              : "open: runs until paused",
          ...(uiWarning ? { warning: uiWarning } : {}),
          text: renderCreateDryRunText(config, nextRuns, uiWarning),
        },
      };
    }

    // Idempotency (F8): a timed-out `loopany new` retry must never make a twin. The
    // daemon sends a stable content key; if we already created a loop for this key on
    // THIS machine within the window, return that loop (an idempotent REPLAY, §4.5)
    // rather than a second one. Checked AFTER validation (so only a real, valid
    // create is deduped) and AFTER the dry-run branch (a preview never dedupes).
    const idempotencyKey = str(body.idempotencyKey);
    if (idempotencyKey) {
      const existingId = readNewIdempotency(idempotencyKey, machineId);
      const existing = existingId ? store.getLoop(existingId) : undefined;
      // Recheck existence + ownership: a since-deleted loop (or a stale record) falls
      // through to a fresh create rather than replaying a loop that is gone.
      if (existing && existing.machineId === machineId) {
        return {
          status: 200,
          body: {
            ok: true,
            id: existing.id,
            name: existing.name ?? existing.id,
            idempotent: true,
            ui: existing.ui != null,
            text: renderReplayText(existing.name ?? existing.id, existing.id, existing.goal),
          },
        };
      }
    }

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
      workflow,
      workdir: str(body.workdir),
      taskFile,
      stateSchema,
      ui,
      notify,
      goal,
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
    // Remember this create against its content key so an immediate retry replays it.
    if (idempotencyKey) recordNewIdempotency(idempotencyKey, machineId, loop.id);
    if (uiDropped) log.warn({ machineId, loopId: loop.id }, "createLoop: provided ui dropped — loop created without a dashboard");
    log.info({ machineId, loopId: loop.id, agent, ui: ui != null }, "createLoop: created from a coding agent");
    // Echo `ui` presence (like dry-run) + a warning when a provided dashboard was
    // dropped, so the CLI/response can surface it — never a silent no-dashboard.
    return {
      status: 200,
      body: {
        ok: true,
        id: loop.id,
        name,
        ui: ui != null,
        ...(uiWarning ? { warning: uiWarning } : {}),
        text: renderCreatedText(name, loop.id, cron, timezone ?? null, goal, ui != null, uiWarning),
      },
    };
  }

  // ---- GET/PATCH /api/machine/loop — the owner's interactive agent edits ----

  /** List the loops bound to this machine, for `loopany loops`. The default columns
   *  are the minimal `{id,name,cron,enabled,nextFire}` (P2); `--fields` extends them
   *  from the optional set, and an unknown field fails loud (P6, VALIDATION_ERROR). */
  listLoops(deviceToken: string, fieldsFlag?: string): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    // --fields extends the default columns with any of the optional set; an unknown
    // field fails loud (exit 1) listing what IS available (matches gh-axi's shape).
    const extras: string[] = [];
    if (fieldsFlag !== undefined) {
      const requested = String(fieldsFlag).split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((f) => !LIST_OPTIONAL_FIELDS.includes(f));
      if (unknown.length) {
        return { status: 400, body: { error: `unknown field(s): ${unknown.join(", ")} — available: ${LIST_OPTIONAL_FIELDS.join(", ")}` } };
      }
      // Preserve request order and dedup.
      for (const f of requested) if (!extras.includes(f)) extras.push(f);
    }
    const fields = [...LIST_DEFAULT_FIELDS, ...extras];
    // The derived cells cost an extra query per loop; only pay for them when the
    // column is actually selected (the default `loopany loops` computes neither).
    const wantRuns = fields.includes("runs");
    const wantLastOutcome = fields.includes("lastOutcome");

    const loops: LoopListRecord[] = store.loopsForMachine(machineId).map((l) => {
      // Derived cadence fire (P4): the NEXT time the cron fires in the loop's tz. A
      // paused loop shows no next fire (— in the cell), matching §4.2.
      const nextFire = l.enabled ? (nextFires(l.cron, l.timezone, 1)[0] ?? null) : null;
      const last = wantLastOutcome ? store.lastRun(l.id) : undefined;
      return {
        id: l.id,
        name: l.name ?? l.id,
        cron: l.cron,
        timezone: l.timezone,
        enabled: l.enabled,
        notify: l.notify,
        model: l.model ?? null,
        goal: l.goal ?? null,
        taskFile: l.taskFile ?? null,
        nextRunAt: l.nextRunAt,
        // Folder hint so a workdir-scoped CLI (`loopany log`) can map the current
        // directory back to a loop the same way the watcher resolves it.
        workdir: l.workdir ?? null,
        nextFire,
        runs: wantRuns ? store.countRuns(l.id) : 0,
        lastOutcome: last ? runOutcomeToken(last) : null,
      };
    });
    return { status: 200, body: { ok: true, loops, text: renderLoopsText(loops, fields) } };
  }

  /**
   * Recent run execution logs (transcripts) for a loop, for the on-machine agent
   * (`loopany log`). The device-facing twin of the web-only `getTranscript`:
   * authed by the SAME device token the daemon already uses, and scoped strictly
   * to a loop bound to THAT machine (`loop.machineId === machineId`, exactly like
   * `editLoop`/`sync`) — a token can never read another loop's or another device's
   * runs. Read-only. Returns the most recent N runs newest-first with each run's
   * outcome, its claude-code `sessionId`, its reported metrics (`state`),
   * and a clipped transcript so the create/update/evolve flows can see how past runs
   * actually went before reshaping the loop.
   */
  loopLog(deviceToken: string, loopId: unknown, limit?: unknown): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    return this.renderLoopLog(machineId, loopId, limit);
  }

  /** The machine-scoped run survey, shared by the device-token `loopLog` (resolves
   *  the machine from the token) AND the unified-dispatch run-credential `log` branch
   *  (passes the run lease's own machineId + loopId — this is what closes the in-run
   *  `loopany log` 400 seam). Scoping is identical for both callers: only a loop
   *  bound to `machineId` is visible; anything else is a flat 404 (existence never
   *  leaks), exactly as before for the device path. */
  private renderLoopLog(machineId: string, loopId: unknown, limit?: unknown): HttpResult {
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
        /** Claude-reported spend (USD estimate) so `loopany log` surfaces run cost. */
        costUsd: r.costUsd ?? null,
        error: r.error ?? null,
        message: r.message ?? null,
        // The claude-code session id lets the agent jump from this survey straight
        // to the run's on-disk `<session>.jsonl` for a deep dive (see evolve.md).
        sessionId: r.sessionId ?? null,
        // The metrics the run reported (the `state` object), so `loopany log`
        // surfaces them alongside the transcript (matches what buildEvolveTask
        // feeds the evolve agent).
        state: r.state ?? null,
        transcript: text,
        transcriptTruncated: truncated,
      };
    });
    // F2: the in-run callback prints `text`, so an empty text is why in-run `loopany
    // log` shows nothing today. Carry the TOON survey ALONGSIDE the structured `runs`
    // (superset body) — an old daemon ignores `text` and renders `runs` unchanged.
    const survey = renderLogText(loop.name ?? loop.id, loop.id, runs, store.countRuns(loopId));
    return { status: 200, body: { ok: true, loopId: loop.id, name: loop.name ?? loop.id, runs, text: survey } };
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
      workflow?: unknown;
      ui?: unknown;
      stateSchema?: unknown;
      goal?: unknown;
    },
    /** Validate-only (`loopany edit --dry-run`): compute the per-key before→after
     *  preview + rejections, persist NOTHING. */
    dryRun = false,
  ): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (typeof id !== "string" || !id) return { status: 400, body: { error: "loop id required" } };
    const loop = store.getLoop(id);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    const p = (patch ?? {}) as Record<string, unknown>;
    // Whitelist: a typo in `--json` must fail loudly, never silently no-op, and
    // no non-listed field (id/teamId/userId/machineId/timestamps/…) may be touched.
    const unknownKeys = Object.keys(p).filter((k) => !EDITABLE_LOOP_FIELDS.has(k));
    // The real path rejects any unknown key up front (unchanged behavior). Dry-run
    // reports them as per-key rejections instead, alongside the valid preview.
    if (!dryRun && unknownKeys.length) {
      return {
        status: 400,
        body: { error: `unknown field(s): ${unknownKeys.join(", ")} — allowed: ${[...EDITABLE_LOOP_FIELDS].join(", ")}` },
      };
    }

    const { update, changes, rejections } = this.buildEditUpdate(loop, p);

    if (dryRun) {
      const allRejections = [
        ...unknownKeys.map((k) => ({ key: k, reason: `unknown field — allowed: ${[...EDITABLE_LOOP_FIELDS].join(", ")}` })),
        ...rejections,
      ];
      // Reflect store.updateLoop's derived lifecycle side effects in the preview so
      // the owner sees the FULL consequence: clearing the goal (goal:null) or
      // reopening a completed loop (enabled:true) also drops the terminal stamps.
      const clearsStamps =
        (update.goal === null || (update.enabled === true && update.completedAt === undefined)) && loop.completedAt != null;
      if (clearsStamps) {
        changes.push({ key: "completedAt", from: loop.completedAt, to: null });
        changes.push({ key: "completionReason", from: loop.completionReason, to: null });
      }
      return {
        status: 200,
        body: {
          ok: allRejections.length === 0,
          dryRun: true,
          id: loop.id,
          name: loop.name ?? loop.id,
          changes,
          rejections: allRejections,
          // The preview request itself succeeds (HTTP 200 + the rich changes/rejections
          // tables), but a rejected key means the proposed patch is invalid — signal
          // that to the CLI as exit 1 (§4.4), not the misleading exit 0 of a clean run.
          exitCode: allRejections.length ? 1 : 0,
          text: renderEditDryRunText(loop.id, loop.name ?? loop.id, changes, allRejections),
        },
      };
    }

    // Real path: a validation rejection fails loudly (first one, preserving the
    // per-field message + order the checks run in).
    if (rejections.length) return { status: 400, body: { error: rejections[0]!.reason } };
    // An empty patch (`edit --json '{}'`) is a VALID no-op (feedback #3), not an
    // error: report `nothing to change` with the allowed-key list rather than a bare
    // usage 400. (`show` existing is the real cure; this makes the seam legible.)
    if (Object.keys(update).length === 0) {
      return {
        status: 200,
        body: {
          ok: true,
          id: loop.id,
          name: loop.name ?? loop.id,
          applied: [],
          nothingToChange: true,
          text: renderEditNoopText(loop.id, loop.name ?? loop.id),
        },
      };
    }

    const updated = store.updateLoop(id, update);
    if (!updated) return { status: 404, body: { error: "loop not found" } };
    // Re-arm the scheduler: an enabled flip toggles add/remove, any other change re-adds.
    if (updated.enabled) this.scheduler.addLoop(updated);
    else this.scheduler.removeLoop(updated.id);
    log.info({ machineId, loopId: id, fields: Object.keys(update) }, "editLoop: applied");
    const applied = Object.keys(update);
    return {
      status: 200,
      body: {
        ok: true,
        id: updated.id,
        name: updated.name ?? updated.id,
        applied,
        text: renderEditAppliedText(updated.id, updated.name ?? updated.id, applied),
      },
    };
  }

  /**
   * Validate + normalize an editLoop patch against the current loop, WITHOUT
   * persisting. Returns the `update` to feed `store.updateLoop`, a per-key
   * `changes` (before→after) preview, and any `rejections` (invalid values).
   * Assumes unknown keys were already filtered by the caller. Field order mirrors
   * the old inline checks so the real path's first-rejection message is stable.
   */
  private buildEditUpdate(
    loop: Loop,
    p: Record<string, unknown>,
  ): { update: Partial<NewLoop>; changes: Array<{ key: string; from: unknown; to: unknown }>; rejections: Array<{ key: string; reason: string }> } {
    const update: Partial<NewLoop> = {};
    const changes: Array<{ key: string; from: unknown; to: unknown }> = [];
    const rejections: Array<{ key: string; reason: string }> = [];
    // A `set` whose new value equals the current one is a NO-OP for the CHANGES
    // preview: the write still flows to `update` (an all-no-op patch is a harmless
    // idempotent re-apply, not a "nothing to change" 400), but it is not RECORDED as a
    // change. This is what makes read/write identity real — feeding a `show --json`
    // envelope back to `edit --dry-run` reports zero changes (the roundtrip pin).
    // Values compare structurally (stateSchema is an array); null and undefined are
    // equal (an absent field re-fed as null is unchanged).
    const set = (key: string, to: unknown, from: unknown): void => {
      (update as Record<string, unknown>)[key] = to;
      if (!sameLoopValue(to, from)) changes.push({ key, from: clipPreview(from), to: clipPreview(to) });
    };

    // Timezone before cron: the cadence probe runs in the loop's EFFECTIVE
    // timezone (the patched one when the patch carries it, else the stored one).
    if (p.timezone !== undefined) {
      const tz = str(p.timezone);
      if (tz && !validTimezone(tz)) rejections.push({ key: "timezone", reason: invalidTimezoneError(tz) });
      else set("timezone", tz, loop.timezone);
    }
    if (p.cron !== undefined) {
      const cron = str(p.cron);
      if (!cron) rejections.push({ key: "cron", reason: "cron cannot be empty" });
      else {
        const c = validCadence(cron, p.timezone !== undefined ? update.timezone : loop.timezone);
        if (!c.ok) rejections.push({ key: "cron", reason: `invalid cron: ${c.detail}` });
        else set("cron", cron, loop.cron);
      }
    }
    if (p.name !== undefined) set("name", str(p.name), loop.name);
    if (p.model !== undefined) set("model", str(p.model), loop.model);
    if (p.taskFile !== undefined) set("taskFile", str(p.taskFile), loop.taskFile);
    if (p.notify !== undefined) {
      const v = p.notify;
      if (v !== "always" && v !== "auto" && v !== "never") rejections.push({ key: "notify", reason: "notify must be always|auto|never" });
      else set("notify", v, loop.notify);
    }
    if (p.allowControl !== undefined) set("allowControl", !!p.allowControl, loop.allowControl);
    if (p.enabled !== undefined) set("enabled", !!p.enabled, loop.enabled);
    // Goal set (non-empty) / clear (null|blank). store.updateLoop enforces the
    // lifecycle invariant: clearing the goal also clears the completion stamps,
    // and enabling a completed loop reopens it (drops the stamps).
    if (p.goal !== undefined) set("goal", str(p.goal)?.slice(0, GOAL_CAP) ?? null, loop.goal);
    if (p.runAt !== undefined) {
      // `null`/blank clears the pinned override (symmetric with goal:null, and what
      // `show --json` re-feeds when there is no override) — a no-op when already null.
      if (p.runAt === null || p.runAt === "") set("nextRunAt", null, loop.nextRunAt);
      // Re-feeding the loop's CURRENT pin verbatim is a recorded no-op, bypassing the
      // future-time guard: a paused/completed loop keeps a stale (past) `nextRunAt` that
      // `show --json` echoes, and roundtripping it back through `edit` must not 400.
      else if (String(p.runAt) === loop.nextRunAt) set("nextRunAt", loop.nextRunAt, loop.nextRunAt);
      else {
        const when = parseWhen(String(p.runAt));
        if (!when) rejections.push({ key: "runAt", reason: "run-at must be 30m|2h|1d or a future ISO time" });
        else if (Date.parse(when) > Date.now() + MAX_NEXT_MS) rejections.push({ key: "runAt", reason: "run-at too far in the future (>30d)" });
        else set("nextRunAt", when, loop.nextRunAt);
      }
    }
    // Content fields reuse the SAME validators the run-token set-* path uses, so
    // the owner edit surface can't drift from the evolve/edit run behavior. They
    // also get the same wire clip discipline as createLoop's workflow.
    // Content fields accept `null` as an explicit clear (what `show --json` re-feeds
    // when the field is unset — a no-op when already null, so the roundtrip holds).
    if (p.workflow !== undefined) {
      if (p.workflow === null) set("workflow", null, loop.workflow);
      else if (typeof p.workflow !== "string") rejections.push({ key: "workflow", reason: "workflow must be a string (the pre-stage JS)" });
      else {
        const v = this.validateWorkflow(p.workflow.slice(0, WIRE_TEXT_CAP));
        if (!v.ok) rejections.push({ key: "workflow", reason: v.detail });
        else set("workflow", v.value, loop.workflow);
      }
    }
    if (p.ui !== undefined) {
      if (p.ui === null) set("ui", null, loop.ui);
      else if (typeof p.ui !== "string") rejections.push({ key: "ui", reason: "ui must be a string (the dashboard HTML)" });
      else set("ui", this.validateUi(p.ui.slice(0, WIRE_TEXT_CAP)).value, loop.ui);
    }
    if (p.stateSchema !== undefined) {
      if (p.stateSchema === null) set("stateSchema", null, loop.stateSchema);
      else {
        const v = this.validateSchema(loop.id, p.stateSchema);
        if (!v.ok) rejections.push({ key: "stateSchema", reason: v.detail });
        else set("stateSchema", v.value, loop.stateSchema);
      }
    }
    return { update, changes, rejections };
  }

  /** Read a New-loop claim's result (the web dialog polls this while waiting). */
  claimStatus(token: string): ClaimResult | undefined {
    return readClaim(token);
  }

  // ---- POST /agent-api/loop ----

  agentApi(runToken: string, argv: string[]): HttpResult {
    const lease = resolveLease(runToken);
    if (!lease) return { status: 401, body: { text: errorBlock("invalid or expired token", "UNAUTHORIZED"), exitCode: 1 } };
    // The run was already reclaimed by the server (the machine was likely asleep).
    // Its lease is terminal-grace: it lives on only to accept ONE reconciling
    // wake-report via /machine/report — never further agent-api mutations
    // (reschedule/set-*/finish).
    if (lease.state === "terminal-grace") {
      return { status: 409, body: { text: errorBlock(RECLAIMED_MSG, "CONFLICT"), exitCode: 1 } };
    }
    const out = this.dispatch(lease, argv);
    return { status: out.code, body: { text: out.text, exitCode: out.code === 200 ? 0 : 1 } };
  }

  // ---- POST /api/machine/cli — one CLI dispatch, keyed by credential ----

  /**
   * The unified CLI endpoint. It is a ROUTER in front of the gateway logic that
   * already exists — never a rewrite — that keys authority on the CREDENTIAL TYPE
   * first, then routes to the same methods the legacy endpoints call:
   *   · DEVICE credential (`dk_`-prefixed) → owner authority over any loop bound to
   *     the machine: `new`→createLoop, `loops`→listLoops, `edit`→editLoop,
   *     `log`→loopLog, `show`→describe. `report`/`finish` are RUN-only (403).
   *   · RUN credential (an `rk_`-prefixed run lease — or a bare-UUID token from a
   *     pre-Batch-6 mint over a deploy) → the least-privilege per-run `dispatch()`
   *     verbs, PLUS a read branch (`log`/`show`) scoped strictly to the lease's OWN
   *     loop — this closes the in-run `loopany log` 400 seam. Owner-only verbs
   *     (`new`/`edit`/`loops`/`status`) are 403 for a run credential.
   * The branch keys on the `dk_` device prefix, NOT an `rk_` run prefix, so a
   * bare-UUID run token still routes to the run path (it just isn't a device token).
   * Floors, `allowControl`, `canFinish`, and the shared content validators all flow
   * through the reused `dispatch`/`createLoop`/`editLoop`/`loopLog` unchanged.
   */
  cli(token: string, argv: string[]): HttpResult {
    const res = token.startsWith("dk_") ? this.deviceCli(token, argv) : this.runCli(token, argv);
    return finalizeCli(res);
  }

  /** DEVICE-credential branch of the unified CLI. */
  private deviceCli(deviceToken: string, argv: string[]): HttpResult {
    const machineId = machineIdFromToken(deviceToken);
    if (!store.getMachine(machineId)) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    const verb = argv[0] ?? "";
    const flags = parseFlags(argv.slice(1));
    const loopArg = typeof flags["loop"] === "string" ? (flags["loop"] as string) : typeof flags["_"] === "string" ? (flags["_"] as string) : "";

    // Per-verb `--help` (P10): full owner-facing help for a device verb (no lease ⇒
    // no availability caveats). An unknown verb has no help spec → falls through to
    // the switch's default (unknown-command 400), matching today's behavior.
    if (flags["help"] === true) {
      const h = verbHelpText(verb);
      if (h) return { status: 200, body: { ok: true, text: h } };
    }

    switch (verb) {
      case "new": {
        const parsed = parseJsonFlag(flags["json"]);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const config = { ...parsed.value } as Record<string, unknown>;
        if (flags["dry-run"] === true) config.dryRun = true;
        return this.createLoop(deviceToken, config);
      }
      case "loops":
        return this.listLoops(deviceToken, typeof flags["fields"] === "string" ? (flags["fields"] as string) : undefined);
      case "edit": {
        const parsed = parseJsonFlag(flags["json"]);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        return this.editLoop(deviceToken, loopArg || undefined, parsed.value as Record<string, unknown>, flags["dry-run"] === true);
      }
      case "log":
        return this.loopLog(deviceToken, loopArg, flags["limit"]);
      case "show": {
        // Device `show` may inspect ANY loop bound to the machine; the machine-scope
        // check mirrors loopLog/editLoop (flat 404, existence never leaks).
        const loop = loopArg ? store.getLoop(loopArg) : undefined;
        if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };
        // `--json`: emit the full editable envelope with complete bodies (the exact
        // `edit --json` shape; the roundtrip transport, §4.1). Otherwise the TOON
        // detail view (size hints by default, full bodies under `--full`).
        if (flags["json"] === true) {
          const env = loopEnvelope(loop);
          return { status: 200, body: { ok: true, loop: env, text: JSON.stringify(env, null, 2) } };
        }
        return { status: 200, body: { ok: true, text: this.describe(loop.id, { full: flags["full"] === true }) } };
      }
      case "report":
      case "finish":
      case "complete":
        // Per §4.1: there is no run to attribute a device-credential report/finish to.
        return { status: 403, body: { error: `loopany: "${verb}" is a run-only verb — a run reports/finishes itself; the owner edits via "edit"` } };
      default:
        return { status: 400, body: { error: `loopany: unknown command "${verb}" for the device credential (try: new, loops, edit, log, show)` } };
    }
  }

  /** RUN-credential branch of the unified CLI: the existing per-run `dispatch()`
   *  verbs, plus the read branch (`log`/`show`) scoped to the lease's own loop. */
  private runCli(runToken: string, argv: string[]): HttpResult {
    const lease = resolveLease(runToken);
    if (!lease) return { status: 401, body: { text: errorBlock("invalid or expired token", "UNAUTHORIZED"), exitCode: 1 } };
    // Reclaimed (machine likely asleep) — terminal-grace accepts only the reconciling
    // /machine/report, never further CLI mutations. Same rule agentApi enforces.
    if (lease.state === "terminal-grace") {
      return { status: 409, body: { text: errorBlock(RECLAIMED_MSG, "CONFLICT"), exitCode: 1 } };
    }
    const verb = argv[0] ?? "";
    const flags = parseFlags(argv.slice(1));

    // Owner-only verbs are never reachable with a run credential (least-privilege):
    // a run has no create/edit/cross-loop-list/machine-status need. Explicit 403 so
    // the denial is legible (not a generic "unknown command").
    if (DEVICE_ONLY_VERBS.has(verb)) {
      return { status: 403, body: { text: errorBlock(`"${verb}" needs the device credential (owner authority); a run may only act on its own loop`, "FORBIDDEN"), exitCode: 1 } };
    }

    // Loop-arg fence: a run may only target its OWN loop. An explicit `--loop` (any
    // verb) or a positional loop id (only `log`/`show` take one) that names another
    // loop is a hard 403 — never a silent retarget onto the run's own loop.
    const targeted = typeof flags["loop"] === "string" ? (flags["loop"] as string) : (verb === "log" || verb === "show") && typeof flags["_"] === "string" ? (flags["_"] as string) : undefined;
    if (targeted !== undefined && targeted !== lease.loopId) {
      return { status: 403, body: { text: errorBlock("a run may only act on its own loop", "FORBIDDEN"), exitCode: 1 } };
    }

    // Per-verb `--help` (P10), role-aware from the lease caps. Covers the read verbs
    // (`log`/`show`) that runCli handles before/around `dispatch` AND the dispatch
    // verbs, so `<verb> --help` is uniform on the run path. An owner-only verb was
    // already 403'd above; an unknown verb has no spec → falls through to `dispatch`
    // (unknown-command 400).
    if (flags["help"] === true) {
      const h = verbHelpText(verb, lease);
      if (h) return { status: 200, body: { text: h, exitCode: 0 } };
    }

    // Read branch — the seam fix. `log` gains a run-credential path (it has no case
    // in `dispatch`, so today it 400s in-run); `show` TOON stays in `dispatch`
    // (already scoped to lease.loopId with the run's caps), but `show --json` needs a
    // structured body (`dispatch` returns text-only), so it is served here.
    if (verb === "log") {
      return this.renderLoopLog(lease.machineId, lease.loopId, flags["limit"]);
    }
    if (verb === "show" && flags["json"] === true) {
      const loop = store.getLoop(lease.loopId);
      if (!loop) return { status: 404, body: { text: errorBlock("loop not found", "NOT_FOUND"), exitCode: 1 } };
      // The full editable envelope — identical shape to the device `show --json`
      // (the run's effective selfSchedule/selfFinish lines are TOON-only, not in the
      // read/write envelope). Scoped to the run's own loop (fenced above).
      const env = loopEnvelope(loop);
      return { status: 200, body: { ok: true, loop: env, text: JSON.stringify(env, null, 2), exitCode: 0 } };
    }

    const out = this.dispatch(lease, argv);
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
      /** Claude-reported cost/usage for this run (usd + token counts). */
      cost?: unknown;
    },
  ): HttpResult {
    const lease = resolveLease(runToken);
    if (!lease) return { status: 401, body: { error: "invalid or expired token" } };
    const ok = !!body.ok;

    const run = store.getRun(lease.runId);
    // The user stopped this run while the machine was still working — keep it
    // canceled, and bail BEFORE any loop-level write: a late report must not
    // advance the workflow cursor / task file (the next run would silently skip
    // data whose output the user never saw), nor flip the phase to done/error.
    if (run?.phase === "canceled") {
      retireLease(runToken);
      // Clear a pending edit even if its run was canceled, so it doesn't re-fire —
      // and symmetrically clear an evolve marker (evolveDue), or the canceled
      // evolve pass re-fires on the very next tick.
      if (lease.role === "edit") this.scheduler.finishEdit(lease.loopId);
      if (lease.role === "evolve") this.scheduler.finishEvolution(lease.loopId);
      log.info({ runId: lease.runId }, "report: ignored (run was canceled)");
      return { status: 200, body: { ok: true } };
    }

    // The run already finalized itself via `loopany finish` (phase "done"): the
    // daemon's normal post-run report still arrives with the precise durationMs +
    // sessionId (+ transcript/artifacts), which finish couldn't know mid-run. ENRICH
    // the already-completed run with those so a finished run's log matches a reported
    // one — but do NOT re-stamp the loop, re-notify, advance the cursor, or re-
    // snapshot (finish did all of that). Then retire the lease: finish deliberately
    // left it active for exactly this one enriching report.
    if (run?.phase === "done") {
      const enrichArtifacts = coerceArtifacts(body.artifacts);
      const enrichTranscript = coerceTranscript(body.transcript);
      store.updateRun(lease.runId, {
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId.slice(0, SESSION_ID_CAP) } : {}),
        ...(enrichArtifacts ? { artifacts: enrichArtifacts } : {}),
        ...(enrichTranscript ? { transcript: enrichTranscript } : {}),
        // Cost, like durationMs, is only known post-run — enrich the finished row.
        ...coerceCost(body.cost),
      });
      if (typeof body.taskFileContent === "string") {
        store.updateLoop(lease.loopId, {
          taskFileContent: body.taskFileContent.slice(0, WIRE_TEXT_CAP),
          taskFileSyncedAt: nowIso(),
        });
      }
      retireLease(runToken);
      log.info({ runId: lease.runId }, "report: enriched a finished run (durationMs/sessionId)");
      return { status: 200, body: { ok: true } };
    }

    // ── Late wake-report for a sweep-RECLAIMED run ─────────────────────────────
    // The machine went unreachable (asleep/offline) mid-run, so the sweep reclaimed
    // this run as a false `error` and pushed a machine-offline alert — but kept the
    // lease alive (terminal-grace) for the grace window instead of retiring it. The
    // daemon has now resumed and delivered the run's REAL result. Honor exactly ONE
    // such late report to correct the record, then retire the lease single-shot
    // (like the finish→enrich handshake). Recognized by the lease's terminal-grace
    // state — set ONLY by `reclaimRun` (via `terminalizeLease`).
    if (run?.phase === "error" && lease.state === "terminal-grace") {
      const artifacts = coerceArtifacts(body.artifacts);
      const transcript = coerceTranscript(body.transcript);
      const rawMessage = body.message !== undefined ? body.message : body.finalText;
      const message = typeof rawMessage === "string" ? rawMessage.slice(0, MESSAGE_CAP) : undefined;
      const claimedOutcome = RUN_OUTCOMES.has(body.outcome as string) ? body.outcome : undefined;
      // Only a SUCCESSFUL reconcile carries the workflow cursor forward — same as
      // the normal path, a failed run must never advance loop.state (the next run's
      // `prev` would bind data whose output the user never saw). Bounded by
      // CURSOR_CAP; an over-cap cursor is dropped, the run still reconciles.
      let cursor = ok ? body.cursor : undefined;
      if (cursor !== undefined) {
        const serialized = JSON.stringify(cursor);
        if ((serialized?.length ?? 0) > CURSOR_CAP) {
          log.warn({ runId: lease.runId, bytes: serialized!.length }, "report: cursor over size cap — ignored");
          cursor = undefined;
        }
      }
      if (typeof body.taskFileContent === "string") {
        store.updateLoop(lease.loopId, {
          taskFileContent: body.taskFileContent.slice(0, WIRE_TEXT_CAP),
          taskFileSyncedAt: nowIso(),
        });
      }
      if (cursor !== undefined) store.updateLoop(lease.loopId, { state: cursor });
      // Mirror the workflow's scalar cursor onto THIS run for {{latest.*}} / the
      // trend chart — don't clobber a state the run already reported.
      const runState = ok && !run.state ? scalarState(cursor) : undefined;
      const finalized = store.updateRun(lease.runId, {
        phase: ok ? "done" : "error",
        outcome: ok ? claimedOutcome ?? (lease.role === "evolve" ? "evolve" : "exec") : "error",
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId.slice(0, SESSION_ID_CAP) } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(transcript ? { transcript } : {}),
        ...(runState ? { state: runState } : {}),
        ...(message !== undefined ? { message } : {}),
        // Success clears the generic reclaim reason; a genuine late failure REPLACES
        // it with the real error (honest record), keeping the run an error.
        ...(ok
          ? { error: null }
          : { error: typeof body.error === "string" ? body.error.slice(0, MESSAGE_CAP) : run.error }),
        progress: null,
        ts: nowIso(),
      });
      // Single-shot: no second late report may re-flip this run.
      retireLease(runToken);
      // Re-capture the end-state snapshot (best-effort), same as the normal path.
      try {
        store.putRunSnapshot(lease.runId, lease.loopId, store.buildLoopManifest(lease.loopId));
        store.pruneRunSnapshots(lease.loopId, snapshotRetention());
      } catch (err) {
        log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
      }
      if (ok && lease.role !== "evolve" && lease.role !== "edit") {
        // The failure alert was WRONG — the run actually succeeded. Flipping the row
        // to `done` already corrects the failure streak (it's derived from persisted
        // rows), so a later tick won't count this. Retract by pushing the real result
        // (a cheap, honest correction), gated by the loop's normal notify policy.
        const loop = store.getLoop(lease.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          void this.notify(loop, finalized.message);
        }
      }
      // A genuine late FAILURE is recorded honestly but does NOT re-notify: the
      // reclaim already alerted the user once for this run.
      log.info(
        { runId: lease.runId, ok, reclaimed: true },
        ok ? "report: reconciled a reclaimed run to done (machine woke)" : "report: recorded a reclaimed run's real error",
      );
      return { status: 200, body: { ok: true, reconciled: true } };
    }

    // Persist the workflow cursor (free-form), if any — bounded by serialized size
    // so a runaway cursor can't bloat the loop row; an over-cap cursor is dropped
    // (the run itself still records normally).
    let cursor = body.cursor;
    if (cursor !== undefined) {
      const serialized = JSON.stringify(cursor);
      if ((serialized?.length ?? 0) > CURSOR_CAP) {
        log.warn({ runId: lease.runId, bytes: serialized!.length }, "report: cursor over size cap — ignored");
        cursor = undefined;
      }
    }
    if (cursor !== undefined) store.updateLoop(lease.loopId, { state: cursor });

    // Sync the machine's task file onto the loop (untrusted wire input — clip
    // defensively even though the daemon already caps it).
    if (typeof body.taskFileContent === "string") {
      store.updateLoop(lease.loopId, {
        taskFileContent: body.taskFileContent.slice(0, WIRE_TEXT_CAP),
        taskFileSyncedAt: nowIso(),
      });
    }

    // Message: a workflow reports it here; a claude run already set it via the
    // agent-api `loopany report` — fall back to claude's final text only if blank.
    // Clipped to the same cap the agent-api report verb enforces.
    const rawMessage =
      body.message !== undefined ? body.message : !run?.message && body.finalText ? body.finalText : undefined;
    const message = typeof rawMessage === "string" ? rawMessage.slice(0, MESSAGE_CAP) : rawMessage;

    const artifacts = coerceArtifacts(body.artifacts);
    const transcript = coerceTranscript(body.transcript);

    // Mirror the workflow's returned cursor scalars onto THIS run, so the
    // generative UI's {{latest.*}} + the trend chart bind. A pure workflow has no
    // `loopany report --state` call (that's how exec loops set run.state), so its
    // metrics would otherwise live only in the loop cursor and never render. Don't
    // clobber a state the run already reported (e.g. a workflow that escalated).
    const runState = ok && !run?.state ? scalarState(cursor) : undefined;

    // Whitelist the claimed outcome (untrusted wire input) — anything outside the
    // known enum falls back to the role default rather than landing in the column.
    const claimedOutcome = RUN_OUTCOMES.has(body.outcome as string) ? body.outcome : undefined;
    const finalized = store.updateRun(lease.runId, {
      phase: ok ? "done" : "error",
      outcome: ok ? claimedOutcome ?? (lease.role === "evolve" ? "evolve" : "exec") : "error",
      durationMs: body.durationMs ?? null,
      // Untrusted wire input — clip like every other free-text field.
      sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, SESSION_ID_CAP) : null,
      ...(artifacts ? { artifacts } : {}),
      ...(transcript ? { transcript } : {}),
      ...coerceCost(body.cost),
      ...(runState ? { state: runState } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(ok ? {} : { error: typeof body.error === "string" ? body.error.slice(0, MESSAGE_CAP) : "run failed on machine" }),
      progress: null, // live signal done — the full transcript supersedes it
      ts: nowIso(),
    });
    retireLease(runToken);

    // Capture the loop's full file set as THIS run's snapshot (Phase 3 diff
    // baseline). Cheap: just record the manifest from the already-synced
    // artifact_files; the diff is computed lazily on read (getRunDiff), never
    // here. The daemon flushes a final run-tagged sync before reporting, so this
    // reflects the run's end-state. Best-effort — never let it fail the report.
    try {
      store.putRunSnapshot(lease.runId, lease.loopId, store.buildLoopManifest(lease.loopId));
      // Bound the snapshot history right away (cheap, keeps the table from growing
      // unbounded between maintenance passes). The blobs this unpins are reclaimed
      // by the periodic GC, not here — the grace window means a just-unreferenced
      // blob isn't collectable yet anyway, and report() must stay lean + zero-exec.
      store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
    }

    if (lease.role === "evolve") {
      this.scheduler.finishEvolution(lease.loopId);
    } else if (lease.role === "edit") {
      // Always clear the marker (done OR error) so a stuck edit can't hijack
      // every subsequent tick. The owner re-issues if it didn't take.
      this.scheduler.finishEdit(lease.loopId);
    } else if (ok) {
      this.scheduler.maybeFlagEvolve(lease.loopId);
    }

    // Notify (the loop's chosen channel), best-effort. Edit/evolve runs are
    // internal (owner config change / self-shaping) — never user-facing, success
    // OR failure. `updateRun` already returned the finalized row.
    if (lease.role !== "evolve" && lease.role !== "edit") {
      if (ok) {
        // Success: gate on the loop's notify policy + the run's content status.
        const loop = store.getLoop(lease.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          void this.notify(loop, finalized.message);
        }
      } else {
        // Failure: surface it (silent failure is the BYOA default failure mode),
        // anti-spam'd by the consecutive-failure streak so a persistently-broken
        // loop doesn't push every tick.
        this.notifyRunFailure(lease.loopId, lease.role, finalized?.error ?? null);
      }
    }
    log.info({ runId: lease.runId, ok }, "report: finalized");
    return { status: 200, body: { ok: true } };
  }

  /**
   * The `loopany finish` verb's effect (closed-loop self-termination): record THIS
   * run as an ordinary success (phase=done, outcome=exec, status=resolved) with the
   * run's summary/metrics, then stamp the loop terminal (completedAt=now,
   * completionReason, enabled=false), remove it from the scheduler, capture the end-
   * state snapshot, and fire a completion notification unless notify=never. Gated
   * upstream by lease.canFinish (exec-on-closed-loop only).
   *
   * TOCTOU guard: canFinish was minted at poll; the owner may have CLEARED the goal
   * since (editLoop {goal:null}) — completing then would violate the invariant
   * "completedAt != null implies goal != null". So re-read the loop and refuse with
   * a clear error when it's no longer a closed loop. Nothing is stamped.
   *
   * The run lease is NOT terminalized here: finish can't know the run's precise
   * durationMs / sessionId mid-run, so it leaves the lease ACTIVE for exactly ONE
   * enriching post-run report (see report()'s phase==="done" branch), which records
   * those and retires it. Leaving the lease active (rather than flipping it to
   * terminal-grace) is deliberate: the run may still `show` or issue a second
   * `finish` — because the lease stays active, a second `finish` on the same run is
   * possible, so this ALSO refuses when the loop is already completed
   * (completedAt != null), keeping finish single-shot (no re-stamp, no re-snapshot,
   * no re-notify). Double-notify/double-finalize stay impossible — both this guard
   * and report()'s phase==="done" branch never re-stamp or re-notify.
   */
  private finishLoop(
    lease: RunLease,
    { message, reason, state }: { message?: string; reason: string | null; state?: Record<string, number | string> },
  ): Applied {
    // TOCTOU: refuse if the loop is no longer closed (goal cleared since poll).
    const current = store.getLoop(lease.loopId);
    if (!current || current.goal == null) {
      return { ok: false, detail: "this loop no longer has a goal to finish — its goal was cleared since this run started" };
    }
    // Idempotency: the run lease stays active for the enriching report, so a second
    // `finish` on the same run is possible — refuse it so completion stays single-shot.
    if (current.completedAt != null) {
      return { ok: false, detail: "this loop is already finished", code: "CONFLICT" };
    }
    const ts = nowIso();
    // Record durationMs server-side from the run's claim/running timestamp so a
    // finished run always carries a duration even if the daemon's enriching report
    // is lost; the enriching report overrides it with the precise value.
    const run = store.getRun(lease.runId);
    const durationMs = run ? Date.now() - Date.parse(run.ts) : NaN;
    store.updateRun(lease.runId, {
      phase: "done",
      outcome: "exec",
      status: "resolved",
      ...(message !== undefined ? { message } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
      progress: null,
      ts,
    });
    const loop = store.updateLoop(lease.loopId, { completedAt: ts, completionReason: reason, enabled: false });
    this.scheduler.removeLoop(lease.loopId);
    // Snapshot the loop's end-state (Phase 3 diff baseline), best-effort like report().
    try {
      store.putRunSnapshot(lease.runId, lease.loopId, store.buildLoopManifest(lease.loopId));
      store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "finish: snapshot capture failed");
    }
    // Completion is a distinct terminal event — notify unless the user opted out
    // of all pushes (notify: "never"). Best-effort (void), like the report path.
    if (loop && loop.notify !== "never") {
      void this.notify(loop, completionMessage(reason, message));
    }
    log.info({ runId: lease.runId, loopId: lease.loopId }, "finish: loop completed");
    return { ok: true, detail: "loop finished — goal met, loop completed" };
  }

  // ---- POST /api/machine/sync ----

  /**
   * Live artifact sync (Bearer DEVICE token — the durable machine identity, NOT
   * the run lease which is retired at run end; live sync runs continuously,
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
    // Byte-backed accepted paths → hash, for the task-file content refresh below.
    const pathHashes = new Map<string, string>();

    // Per-loop storage cap (runaway guard). We track a PROJECTED footprint as we
    // reconcile: the loop's already-stored bytes plus any NEW bytes this sync would
    // add (a file pointing at a hash the server doesn't yet have). When accepting a
    // new file would push it past the cap we reject THAT file — skip its bytes + its
    // row — so existing files and deletions still reconcile (the loop never gets
    // wedged), and surface the cap on the response (mirrors the per-file oversize
    // signal). Reusing an already-stored hash adds no bytes, so it's always allowed.
    const bytesCap = loopBytesCap();
    let projectedBytes = store.loopStoredBytes(loopId);
    // Per-path breakdown of that same footprint (one upfront query, not two point
    // queries per manifest file) — consulted for the overwrite "freed" credit below.
    const priorSizes = store.liveArtifactSizes(loopId);
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
        // The freed credit uses the VERIFIED stored length (blobs.size — the same
        // basis loopStoredBytes counts), falling back to the reported size only for
        // a pending row: an OVER-reported prior size must not mint free headroom.
        // (liveArtifactSizes carries only live, byte-backed rows, so a tombstoned /
        // oversize / hash-less prior contributes 0 — same rule as before.)
        const freed = priorSizes.get(rel) ?? 0;
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
        // Verified inline byte length beats the client-reported size when in hand.
        size: inlined ? inlined.length : sizeOk ? rawSize : null,
        binary: binary || (inlined ? looksBinary(inlined) : false),
        oversize: false,
        lastRunId: runId,
      });
      keepPaths.push(rel);
      pathHashes.set(rel, hash);
    }

    // Persist the inline blobs (bytes-first, then metadata row). Parse the product's
    // front matter ONCE here, where the bytes first arrive — content-addressed, so a
    // dedup re-reference (blob already recorded) reuses the stored meta rather than
    // re-parsing (the conflict no-op keeps it), and a binary blob is never parsed.
    for (const [hash, bytes] of toStore) {
      await this.blobStore.put(hash, bytes);
      if (store.blobExists(hash)) continue; // dedup: meta already computed for this hash
      const binary = looksBinary(bytes);
      store.recordBlob(hash, bytes.length, binary, binary ? null : artifactMeta(bytes.toString("utf8")));
    }

    // Task-file live refresh: when this manifest carries the loop's task file and
    // its bytes are in hand (inline this request, or already stored — dedup), mirror
    // them onto loops.taskFileContent, the column the Files panel's task pane
    // renders. report() used to be the ONLY writer, which left a brand-new loop's
    // README invisible until its first run finished; this closes that gap and also
    // reflects idle-time human edits within a flush. Bytes still pending a PUT are
    // handled by putBlob's mirror below.
    await this.refreshTaskFileContent(loop, pathHashes, async (hash) =>
      toStore.get(hash) ?? inline.get(hash) ?? (store.blobExists(hash) ? await this.blobStore.get(hash) : null),
    );

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

  /** Mirror the loop's task-file bytes onto `loops.taskFileContent` (+ stamp
   *  `taskFileSyncedAt`) when the synced manifest's best task-file match has its
   *  bytes available. Path selection reuses `pickTaskPath` — the exact matcher the
   *  Files panel dedups with — so server and UI can never disagree about which
   *  synced file IS the task file. Binary bytes and unchanged content are no-ops. */
  private async refreshTaskFileContent(
    loop: Loop,
    pathHashes: Map<string, string>,
    bytesFor: (hash: string) => Promise<Buffer | null | undefined>,
  ): Promise<void> {
    if (!loop.taskFile) return;
    const best = pickTaskPath(loop.taskFile, [...pathHashes.keys()]);
    if (!best) return;
    const bytes = await bytesFor(pathHashes.get(best)!);
    if (!bytes || looksBinary(bytes)) return;
    const text = bytes.toString("utf8").slice(0, WIRE_TEXT_CAP);
    if (text === loop.taskFileContent) return; // unchanged → no row churn per flush
    store.updateLoop(loop.id, { taskFileContent: text, taskFileSyncedAt: nowIso() });
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
    // Upload gate: only accept bytes the sync handshake actually asked THIS machine
    // for — i.e. a hash a live artifact_files row on one of its loops points at
    // (the row sync wrote when it returned the hash in needHashes). Any other PUT
    // (an arbitrary self-hashed blob nothing references) is refused, so a device
    // token can't be used as an uncapped R2 write channel. A re-PUT of a still-
    // referenced hash stays accepted (idempotent — daemon retries are safe).
    if (!store.machineReferencesBlob(machineId, hash)) {
      return { status: 403, body: { error: "hash was not requested for this machine (sync a manifest first)" } };
    }

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
    // Parse front matter once at this ingress point too (same content-addressed
    // reuse: a re-PUT of an already-recorded hash no-ops and keeps its meta; binary
    // bytes are never parsed).
    const binary = looksBinary(bytes);
    store.recordBlob(hash, bytes.length, binary, binary ? null : artifactMeta(bytes.toString("utf8")));
    // Late-arriving task-file bytes: a task file over the daemon's inline cap rides
    // this PUT (sync couldn't mirror it — no bytes in hand, and no follow-up sync is
    // guaranteed on an idle folder). Mirror onto each referencing loop whose task
    // file this blob backs, via the same refresh path sync uses.
    if (!binary) {
      for (const loopId of store.loopsReferencingHash(hash)) {
        const loop = store.getLoop(loopId);
        if (!loop?.taskFile) continue;
        const rows = store.listArtifacts(loopId).filter((r) => r.hash);
        await this.refreshTaskFileContent(
          loop,
          new Map(rows.map((r) => [r.path, r.hash!] as const)),
          async (h) => (h === hash ? bytes : null), // only THIS blob's bytes are new
        );
      }
    }
    return { status: 200, body: { ok: true } };
  }

  /** Read a stored blob's bytes (Phase 2 download seam; null when absent). */
  readBlob(hash: string): Promise<Buffer | null> {
    if (!isValidHash(hash)) return Promise.resolve(null);
    return this.blobStore.get(hash);
  }

  // ---- agent-api verb dispatch (compact port of control.ts) ----

  private dispatch(lease: RunLease, argv: string[]): { code: number; text: string } {
    const verb = argv[0];
    const flags = parseFlags(argv.slice(1));
    const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

    // Per-verb `--help` (P10): a concrete verb carrying `--help` gets that verb's
    // syntax + flags + templates, role-aware from the lease caps. (The unified
    // `runCli` intercepts this before dispatch; this branch covers the legacy
    // `/agent-api/loop` transport, which reaches `dispatch` directly.)
    if (typeof verb === "string" && verb && flags["help"] === true) {
      const h = verbHelpText(verb, lease);
      if (h) return { code: 200, text: h };
    }

    switch (verb) {
      case undefined:
      case "":
      case "-h":
      case "--help":
      case "help":
        return { code: 200, text: this.helpText(lease) };
      case "report": {
        const rawState = str("state") ?? str("state-content");
        let state: Record<string, number | string> | undefined;
        if (rawState !== undefined) {
          const loop = store.getLoop(lease.loopId);
          const v = validateState(rawState, loop?.stateSchema ?? undefined);
          if (!v.ok) return derr(400, v.error, "VALIDATION_ERROR");
          state = v.value;
        }
        // F5 (fail-loud): a bad --status was previously gated into `{}` by `isStatus`
        // — the typo dropped silently, exit 0. Reject it up front instead.
        const status = str("status");
        if (status !== undefined && !isStatus(status)) {
          return derr(400, `status must be new|resolved|nothing-new (got "${status}")`, "VALIDATION_ERROR");
        }
        const message = str("message");
        store.updateRun(lease.runId, {
          ...(status !== undefined ? { status: status as RunStatus } : {}),
          // Clipped to the same cap the report finalText fallback enforces.
          ...(message !== undefined ? { message: message.slice(0, MESSAGE_CAP) } : {}),
          ...(state !== undefined ? { state } : {}),
        });
        return { code: 200, text: renderReportedText(status, state, message !== undefined) };
      }
      case "show":
        return {
          code: 200,
          text: this.describe(lease.loopId, { allowControl: lease.allowControl, canFinish: lease.canFinish, full: flags["full"] === true }),
        };
      case "log": {
        // The run's OWN-loop history. Batch 4 wired this into dispatch so the help
        // that advertises `log` is truthful on BOTH the unified `/api/machine/cli`
        // (runCli) AND the legacy `/agent-api/loop` transport (which reaches dispatch
        // directly). Scoped to the lease's own loop/machine — dispatch never reads a
        // loop id from flags, so a run can never target another loop (the loop-fence
        // lives in runCli for the positional-arg case).
        const res = this.renderLoopLog(lease.machineId, lease.loopId, flags["limit"]);
        return { code: res.status, text: (res.body as { text?: string }).text ?? "" };
      }
      case "finish":
      case "complete": {
        if (!lease.canFinish) {
          // canFinish is false both for OPEN loops (no goal) and for evolve/edit
          // runs — give the right message for each. The open-loop case is primary.
          const loop = store.getLoop(lease.loopId);
          if (!loop || loop.goal == null) {
            return derr(403, "this loop has no goal to finish (it's an open/monitor loop)", "FORBIDDEN");
          }
          return derr(403, "only an exec run may finish a loop", "FORBIDDEN");
        }
        // F5 (fail-loud): reject a bad --status here too, even though finish forces
        // status=resolved internally — a typo must never pass silently.
        const fstatus = str("status");
        if (fstatus !== undefined && !isStatus(fstatus)) {
          return derr(400, `status must be new|resolved|nothing-new (got "${fstatus}")`, "VALIDATION_ERROR");
        }
        // Optional --state, validated exactly like the report verb.
        const rawState = str("state") ?? str("state-content");
        let state: Record<string, number | string> | undefined;
        if (rawState !== undefined) {
          const loop = store.getLoop(lease.loopId);
          const v = validateState(rawState, loop?.stateSchema ?? undefined);
          if (!v.ok) return derr(400, v.error, "VALIDATION_ERROR");
          state = v.value;
        }
        const message = str("message")?.slice(0, MESSAGE_CAP);
        const reason = str("reason")?.slice(0, MESSAGE_CAP) ?? null;
        const r = this.finishLoop(lease, { message, reason, state });
        return r.ok ? { code: 200, text: renderFinishedText(lease.loopId) } : derr(400, r.detail ?? "rejected", r.code);
      }
      case "set-ui": {
        if (!lease.canSetUi) return derr(403, "only the evolution or edit pass may set the UI", "FORBIDDEN");
        const html = str("body") ?? str("file-content");
        if (html === undefined) return derr(400, "set-ui needs --file <path> (shim inlines it)", "VALIDATION_ERROR");
        const r = this.applySetUi(lease.loopId, html);
        this.audit(lease, "set-ui", { bytes: String(html.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "ui updated" } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
      }
      case "set-schema": {
        if (!lease.canSetSchema) return derr(403, "only the evolution or edit pass may set the schema", "FORBIDDEN");
        const json = str("body") ?? str("file-content");
        if (json === undefined) return derr(400, "set-schema needs --file <path> (a JSON array of {key,label,unit})", "VALIDATION_ERROR");
        const r = this.applySetSchema(lease.loopId, json);
        this.audit(lease, "set-schema", { bytes: String(json.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "schema updated" } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
      }
      case "set-workflow": {
        if (!lease.canSetWorkflow) return derr(403, "only the evolution or edit pass may set the workflow", "FORBIDDEN");
        const body = str("body") ?? str("file-content");
        if (!body) return derr(400, "set-workflow needs --file <path> (shim inlines it)", "VALIDATION_ERROR");
        const r = this.applySetWorkflow(lease.loopId, body);
        this.audit(lease, "set-workflow", { bytes: String(body.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "workflow updated" } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
      }
    }

    if (MUTATION_VERBS.has(verb ?? "")) {
      if (!lease.allowControl) return derr(403, "this loop may not change its own schedule (allowControl is off)", "FORBIDDEN");
      const r = this.applyMutation(lease.loopId, verb!, flags, str);
      this.audit(lease, verb!, stringifyFlags(flags), r);
      return r.ok ? { code: 200, text: r.detail ?? `${verb} applied` } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
    }
    return derr(400, `unknown command "${verb ?? ""}" (try: loopany help)`, "VALIDATION_ERROR");
  }

  /** Usage for `loopany help` / `--help` / a bare invocation, rendered as the §4.9
   *  axi TOON: grouped verbs with an availability tag reflecting THIS lease's caps
   *  (always / finish / dashboard-gate / schedule), then a trailing `help[]`. Still
   *  role-aware — the tags flip with the lease's role + caps, so the agent never
   *  wastes a turn probing a verb it'll be 403'd on. */
  private helpText(lease: RunLease): string {
    const finishTag = lease.canFinish
      ? "available — declare the goal met (--message <achieved> [--reason <one line>])"
      : `exec run on a goal (closed) loop only — this run is "${lease.role}"`;
    const structural = lease.canSetUi ? "available to this run" : `evolve/edit pass only — this run is "${lease.role}"`;
    const control = lease.allowControl ? "available to this run" : "needs allowControl (off for this loop)";

    // The `always` group is a typed list; indent every line two spaces to nest it
    // under the `verbs:` top key (matching the reference tool's nested shape).
    const always = indent(
      listBlock("always", ["verb", "syntax"], [
        ["report", "[--status new|resolved|nothing-new] [--message <s>] [--state '{\"k\":n}' | --state-file <p>]"],
        ["show", "print this loop's config + recent state"],
        ["log", "recent run survey for this loop"],
      ]),
    );
    // The schedule group is a typed list whose HEADER carries the availability tag
    // (a list header with a trailing tag, per §4.9). Build the header by hand so the
    // tag rides after the `{…}:` and indent the whole block under `verbs:`.
    const scheduleRows: Scalar[][] = [
      ["reschedule", "--run-at <30m|2h|ISO>   one extra run soon, then resume cadence"],
      ["set-cron", '"<5-field cron>"   change the cadence (floor applies)'],
      ["pause/resume", "toggle this loop"],
      ["notify", "always|auto|never · set-name/-tz/-model"],
    ];
    const schedule = indent(
      [
        `schedule[${scheduleRows.length}]{verb,syntax}: ${control}`,
        ...scheduleRows.map((r) => `  ${r.map(scalar).join(",")}`),
      ].join("\n"),
    );
    return doc(
      "verbs:",
      always,
      `  finish: ${finishTag}`,
      `  dashboard/gate: ${structural}`,
      schedule,
      helpBlock([
        "Run `loopany show` to read the current config before changing it",
        "Run `loopany report --status nothing-new` to close this run with no news",
      ]),
    );
  }

  private applyMutation(loopId: string, verb: string, flags: Flags, str: (k: string) => string | undefined): Applied {
    switch (verb) {
      case "reschedule": {
        // F4: `--run-at` is canonical (aligns with the `runAt` edit key + the help
        // text); `--next` is kept as a working back-compat alias so existing
        // prompts/scripts don't break. Both drive the same pinned one-shot next fire.
        const raw = str("run-at") ?? str("next");
        const when = raw ? parseWhen(raw) : undefined;
        if (!when) return { ok: false, detail: `reschedule needs --run-at <30m|2h|ISO>` };
        if (Date.parse(when) > Date.now() + MAX_NEXT_MS) return { ok: false, detail: "too far in the future (>30d)" };
        // Self-schedule floor (RUN path only; the owner's edit path is unlimited): a
        // run may not schedule itself sooner than the reschedule floor.
        const floorMin = selfRescheduleFloorMinutes();
        if (Date.parse(when) - Date.now() < floorMin * 60_000) {
          return { ok: false, detail: `a run can't reschedule sooner than ${floorMin} min out — the owner can set any time via edit` };
        }
        const loop = store.updateLoop(loopId, { nextRunAt: when });
        if (loop) this.scheduler.addLoop(loop);
        return { ok: true, detail: `next run at ${new Date(when).toLocaleString()}` };
      }
      case "set-cron": {
        const cron = str("_") ?? str("cron");
        if (!cron) return { ok: false, detail: 'set-cron needs the expression, e.g. set-cron "*/30 * * * *"' };
        const tz = store.getLoop(loopId)?.timezone;
        const c = validCadence(cron, tz);
        if (!c.ok) return c;
        // Self-schedule floor (RUN path only; owner's edit path is unlimited): a run
        // may not set a cron whose adjacent fires (probed in the loop's tz, like
        // validCadence) are closer than the cron floor.
        const floorMin = selfCronFloorMinutes();
        const interval = cronIntervalMs(cron, tz);
        if (interval !== null && interval < floorMin * 60_000) {
          return {
            ok: false,
            detail: `a run can't schedule more often than every ${floorMin} min (that cron fires every ~${Math.round(interval / 60_000)} min) — the owner can set any cadence via edit`,
          };
        }
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

  // ---- content-field validators/normalizers (shared by the run-token set-*
  // path AND the owner device-token `editLoop` path, so both surfaces validate
  // identically and can't drift). Each returns a normalized value ready to feed
  // `store.updateLoop`, or a `{ ok:false, detail }` the caller maps to a 400. ----

  /** Sanitize/normalize dashboard HTML → the stored value (or null to clear). */
  private validateUi(html: string): { ok: true; value: string | null } {
    return { ok: true, value: store.coerceUi(html) ?? null };
  }

  /** Validate + normalize the deterministic pre-stage JS → the stored value (or
   *  null to clear). A workflow body is NOT an ES module: the daemon runner
   *  (`workflow.ts` buildWrapper) interpolates it into an async arrow inside a
   *  generated ESM file, so top-level `export`/`import` (e.g. the Claude Code
   *  Workflow tool's `export const meta = {…}` header) is a PARSE error that
   *  kills the whole run before any line executes. We catch that at write time
   *  with a zero-exec parse check: the AsyncFunction constructor COMPILES the
   *  body (as the async-function body the runner will wrap it in, strict-mode
   *  matched to the ESM wrapper) but never RUNS it. Mirrors validateSchema's
   *  discriminated-union shape so the call sites map ok:false to a 400/rejection. */
  private validateWorkflow(body: string): { ok: true; value: string | null } | { ok: false; detail: string } {
    const src = body.trim();
    if (!src) return { ok: true, value: null }; // clearing the workflow is fine
    try {
      // Zero-exec: the constructor compiles but does not execute the body.
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
      new AsyncFunction("prev", "agent", "tools", "fetch", '"use strict";\n' + src);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const hint = /export|import/.test(raw)
        ? " — a Loopany workflow is a plain script body (statements + `return {message?, state?}`), NOT an ES module and NOT the Claude Code Workflow tool format: remove any top-level `export`/`import` (e.g. `export const meta = {...}`). Use the injected globals `prev`/`agent`/`tools`/`fetch` directly."
        : "";
      return { ok: false, detail: `workflow has a syntax error: ${raw}${hint}` };
    }
    return { ok: true, value: src };
  }

  /** Validate a state schema. Accepts a JSON string (run-token path) or an
   *  already-parsed value (an `editLoop` JSON patch may carry the array inline).
   *  Enforces the additive rule: keys still bound by the UI or reported by
   *  recent runs may not be dropped. */
  private validateSchema(loopId: string, input: unknown): { ok: true; value: StateField[] } | { ok: false; detail: string } {
    if (!store.getLoop(loopId)) return { ok: false, detail: "loop not found" };
    let parsed: unknown = input;
    if (typeof input === "string") {
      try {
        parsed = JSON.parse(input);
      } catch {
        return { ok: false, detail: 'schema must be JSON, e.g. [{"key":"mrr","label":"MRR","unit":"$"}]' };
      }
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
    return { ok: true, value: schema };
  }

  private applySetUi(loopId: string, html: string): Applied {
    const { value: ui } = this.validateUi(html);
    const loop = store.updateLoop(loopId, { ui });
    if (!loop) return { ok: false, detail: "loop not found" };
    return { ok: true, detail: ui ? `ui updated (${ui.length} bytes)` : "ui cleared" };
  }

  private applySetWorkflow(loopId: string, body: string): Applied {
    const v = this.validateWorkflow(body);
    if (!v.ok) return { ok: false, detail: v.detail };
    const loop = store.updateLoop(loopId, { workflow: v.value });
    if (!loop) return { ok: false, detail: "loop not found" };
    return { ok: true, detail: loop.workflow ? `workflow updated (${loop.workflow.length} bytes)` : "workflow cleared" };
  }

  private applySetSchema(loopId: string, json: string): Applied {
    const v = this.validateSchema(loopId, json);
    if (!v.ok) return { ok: false, detail: v.detail };
    store.updateLoop(loopId, { stateSchema: v.value });
    return { ok: true, detail: `schema set (${v.value.map((f) => f.key).join(", ")})` };
  }

  // The full editable envelope (F1/F6, §4.1 batch 2): every EDITABLE_LOOP_FIELDS key
  // keyed EXACTLY as `edit --json` accepts, PLUS the read-only derived aggregates
  // (nextFire/classification/runs). Large content (ui/workflow) shows a presence+size
  // hint by default and inlines under `--full`; stateSchema renders structurally.
  //
  // `opts.allowControl`/`opts.canFinish` are a RUN caller's EFFECTIVE capabilities
  // (the run lease's `structural || loop.allowControl`, and the exec-on-closed-loop
  // finish gate); when present the run adds the `selfSchedule`/`selfFinish` effective
  // lines and run-appropriate help. A device caller passes neither and gets the
  // owner-facing help (edit/log). `--json` is emitted by the callers, not here.
  private describe(loopId: string, opts: { allowControl?: boolean; canFinish?: boolean; full?: boolean } = {}): string {
    const loop = store.getLoop(loopId);
    if (!loop) return "loop not found";
    // The most recent exec run (newest-first) anchors the `runs:` tally's last-outcome.
    const recent = store.listRuns(loop.id, LOG_RUNS_DEFAULT).slice().reverse();
    const lastExec = recent.find((r) => r.role === "exec") ?? null;
    return renderShowText(loop, loopEnvelope(loop), store.countRuns(loop.id), lastExec, opts);
  }

  private audit(lease: RunLease, command: string, args: Record<string, string>, r: Applied): void {
    const run = store.getRun(lease.runId);
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
    store.updateRun(lease.runId, { control });
  }
}

// ---- helpers (ported from control.ts) ----

interface Applied {
  ok: boolean;
  detail?: string;
  /** An explicit axi error slug for a rejection (else the caller derives it from the
   *  HTTP status). Used to mark a second-`finish` as CONFLICT rather than a generic
   *  VALIDATION_ERROR. */
  code?: string;
}
type Flags = Record<string, string | boolean>;

const MUTATION_VERBS = new Set(["reschedule", "set-cron", "pause", "resume", "notify", "set-name", "set-tz", "set-model"]);

/** The one message for a reclaimed (terminal-grace) run's refused CLI mutation —
 *  shared by `agentApi` + `runCli` so the two transports can't drift. */
const RECLAIMED_MSG =
  "this run was reclaimed by the server (the machine was likely asleep); its result is delivered via the final report";

/** Verbs that require OWNER (device) authority — a run credential is 403'd on these
 *  in the unified `cli` dispatch (§4.1). `report`/`finish` are the mirror image
 *  (run-only, 403 for a device credential) and are handled inline in `deviceCli`. */
const DEVICE_ONLY_VERBS = new Set(["new", "edit", "loops", "status"]);

/** Parse a `--json '<obj>'` flag into an object. Absent → an empty object (the
 *  downstream createLoop/editLoop validators then produce the precise error, e.g.
 *  "cron required"). Present-but-not-a-JSON-object → a legible 400. Shared by the
 *  device-credential `new`/`edit` verbs of the unified CLI. */
function parseJsonFlag(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === true) return { ok: true, value: {} };
  if (typeof raw !== "string") return { ok: false, error: "loopany: --json must be a JSON object string" };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "loopany: --json must be valid JSON (an object)" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "loopany: --json must be a JSON object" };
  return { ok: true, value: obj as Record<string, unknown> };
}

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

// ---- TOON render helpers (batch 1: the axi-conformance spine) ----------------
// Each builds the `text` a `/api/machine/cli` verb carries ALONGSIDE its structured
// fields (superset body). Pure — no I/O, no clock — so they're exercised both here
// (via the verb tests) and directly in `toon.test.ts`.

/** Compact a stored ISO timestamp to `YYYY-MM-DD HH:MM` (UTC, as stored) for a TOON
 *  cell — a date the agent reads at a glance without the `T`/seconds/zone noise. */
function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** A structured error result to STDOUT (P6): `error:`/`code:` TOON as the verb `text`.
 *  Mirrors the `{code, text}` shape `dispatch` returns; the slug defaults from the
 *  HTTP status but a caller may pin it (e.g. CONFLICT). */
function derr(code: number, message: string, slug?: string): { code: number; text: string } {
  return { code, text: errorBlock(message, slug ?? codeForStatus(code)) };
}

/** Ensure a `/api/machine/cli` body carries `text` + `exitCode` (P1/P6). A body that
 *  already rendered its own `text` (every success + the dispatch errors) is left
 *  alone; a structured `{error}` (createLoop/editLoop validation, the deviceCli
 *  denials) is rendered to `error:`/`code:` TOON here so the daemon prints it to
 *  stdout. Idempotent + additive: structured fields are never removed. */
function finalizeCli(res: HttpResult): HttpResult {
  const b = res.body;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const body = b as Record<string, unknown>;
    if (typeof body.text !== "string" && typeof body.error === "string") {
      body.text = errorBlock(body.error, codeForStatus(res.status));
    }
    if (typeof body.exitCode !== "number") {
      body.exitCode = res.status >= 200 && res.status < 300 ? 0 : 1;
    }
  }
  return res;
}

/** `loopany loops` default columns (P2 — minimal): identity + the two things an
 *  agent scans for (schedule + when it next fires). */
const LIST_DEFAULT_FIELDS: string[] = ["id", "name", "cron", "enabled", "nextFire"];
/** The optional columns `--fields` may add (the "available" set an unknown field is
 *  measured against, §4.2). `runs`/`lastOutcome` are derived per loop. */
const LIST_OPTIONAL_FIELDS: string[] = ["timezone", "notify", "model", "goal", "taskFile", "runs", "lastOutcome"];

/** A loop's row for `loopany loops`: every renderable cell precomputed once (so the
 *  `--fields` selection is a pure column pick). The structured `loops` body carries
 *  the whole record (superset — an old daemon reads the fields it knows). */
interface LoopListRecord {
  id: string;
  name: string;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  notify: string;
  model: string | null;
  goal: string | null;
  taskFile: string | null;
  nextRunAt: string | null;
  workdir: string | null;
  /** Derived: the next cron fire in the loop's tz (ISO), or null when paused. */
  nextFire: string | null;
  /** Derived: total run count. */
  runs: number;
  /** Derived: the most recent run's outcome token, or null (no runs yet). */
  lastOutcome: string | null;
}

/** One `loops` cell for a named column (scalar-rendered by `listBlock`). */
function loopCell(rec: LoopListRecord, field: string): Scalar {
  switch (field) {
    case "id": return rec.id;
    case "name": return rec.name;
    case "cron": return rec.cron;
    case "enabled": return rec.enabled ? "on" : "paused";
    case "nextFire": return rec.nextFire ? fmtTime(rec.nextFire) : null;
    case "timezone": return rec.timezone;
    case "notify": return rec.notify;
    case "model": return rec.model;
    case "goal": return rec.goal;
    case "taskFile": return rec.taskFile;
    case "runs": return rec.runs;
    case "lastOutcome": return rec.lastOutcome;
    default: return null;
  }
}

/** `loopany loops` — the typed loop list (P2/P4/P5/P9). Columns = the default set
 *  plus any `--fields` extras (validated + resolved by `listLoops`). */
function renderLoopsText(loops: LoopListRecord[], fields: string[]): string {
  if (!loops.length) {
    return doc(
      countLine(0),
      emptyList("loops"),
      helpBlock([
        "Run `loopany new --json '{\"cron\":\"0 8 * * *\",\"taskFile\":\"<path>\"}'` to create your first loop",
        "Run `loopany up` if this machine isn't connected yet",
      ]),
    );
  }
  return doc(
    countLine(loops.length),
    listBlock(
      "loops",
      fields,
      loops.map((l) => fields.map((f) => loopCell(l, f))),
    ),
    helpBlock(["Run `loopany show <id>` to see a loop's full config", "Run `loopany log <id>` to see a loop's recent runs"]),
  );
}

/** One run's `outcome` cell: an evolve pass reads `evolve`; otherwise `ok`/`failed`
 *  (from the phase) suffixed with the content status (`ok/nothing-new`). */
function runOutcomeToken(r: { phase: string; outcome: string | null; status: string | null }): string {
  if (r.outcome === "evolve") return "evolve";
  const base = r.phase === "error" ? "failed" : r.phase === "done" ? "ok" : r.phase;
  return r.status ? `${base}/${r.status}` : base;
}

/** A run's reported metrics as `k=v,k=v` (or null → the em-dash), for the log cell. */
function runMetricsToken(state: Record<string, unknown> | null | undefined): string | null {
  if (!state || typeof state !== "object") return null;
  const parts = Object.entries(state).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(",") : null;
}

/** How many chars of a run message the log cell inlines before the size hint. */
const LOG_MESSAGE_CELL_CAP = 100;

interface LogRun {
  ts: string;
  role: string;
  phase: string;
  outcome: string | null;
  status: string | null;
  costUsd: number | null;
  sessionId: string | null;
  state: Record<string, unknown> | null;
  message: string | null;
}

/** `loopany log` — the TOON run survey (F2: the in-run callback prints this `text`,
 *  so in-run `loopany log` starts working the day Batch 1 deploys). */
function renderLogText(name: string, loopId: string, runs: LogRun[], total: number): string {
  const head = `loop: ${scalar(name)} (${loopId})`;
  if (!runs.length) {
    return doc(
      head,
      countLine(0, { total }),
      emptyList("runs"),
      helpBlock([`Run \`loopany show ${loopId}\` to see the loop config`]),
    );
  }
  const rows: (string | number | null)[][] = runs.map((r) => [
    fmtTime(r.ts),
    r.role,
    runOutcomeToken(r),
    r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : null,
    runMetricsToken(r.state),
    r.sessionId,
    r.message ? truncate(r.message, LOG_MESSAGE_CELL_CAP, "use --full").value : null,
  ]);
  const ok = runs.filter((r) => r.phase === "done").length;
  const failed = runs.filter((r) => r.phase === "error").length;
  const lastExec = runs.find((r) => r.role === "exec");
  const summary = [
    `showing ${runs.length} of ${total}`,
    `${ok} ok`,
    ...(failed ? [`${failed} failed`] : []),
    ...(lastExec ? [`last exec ${runOutcomeToken(lastExec)} ${fmtTime(lastExec.ts)}`] : []),
  ].join(" · ");
  return doc(
    head,
    countLine(runs.length, { total }),
    listBlock("runs", ["ts", "role", "outcome", "cost", "metrics", "session", "message"], rows),
    `summary: ${summary}`,
    helpBlock([
      `Run \`loopany log ${loopId} --full\` to inline each run's transcript`,
      "Run `find ~/.claude/projects -name '<session>.jsonl'` to deep-dive a run's session",
    ]),
  );
}

/** `loopany new` (real create) — the created-loop confirmation (P4/P9). */
function renderCreatedText(
  name: string,
  loopId: string,
  cron: string,
  timezone: string | null,
  goal: string | null,
  uiApplied: boolean,
  warning: string | undefined,
): string {
  const nextRuns = nextFires(cron, timezone, 3).map(fmtTime);
  return doc(
    `created: ${scalar(name)} (${loopId})`,
    `classification: ${goal != null ? "closed — self-finishes when the goal is met" : "open — runs until paused"}`,
    `dashboard: ${uiApplied ? "applied" : "not applied"}`,
    nextRuns.length ? inlineArray("nextRuns", nextRuns, " · ") : null,
    warning ? kvLine("warning", warning) : null,
    helpBlock([
      `Run \`loopany show ${loopId}\` to see the full config`,
      `Run \`loopany log ${loopId}\` after the first run to see how it went`,
    ]),
  );
}

/** `loopany new` idempotent REPLAY (§4.5, F8) — the existing loop returned, never a
 *  twin. Terser than a fresh create (no dashboard/nextRuns lines): the loop already
 *  exists, so the agent just needs to know which one and how to inspect it. */
function renderReplayText(name: string, loopId: string, goal: string | null): string {
  return doc(
    `created: ${scalar(name)} (${loopId}) [idempotent replay — existing loop returned]`,
    `classification: ${goal != null ? "closed — self-finishes when the goal is met" : "open — runs until paused"}`,
    helpBlock([`Run \`loopany show ${loopId}\` to see the full config`]),
  );
}

/** `loopany new --dry-run` — the normalized config + fire preview (no persistence). */
function renderCreateDryRunText(
  config: { name: string | null; cron: string; timezone: string | null; taskFile: string | null; workflow: boolean; ui: boolean; goal: string | null; notify: string },
  nextRuns: string[],
  warning: string | undefined,
): string {
  return doc(
    detailBlock("dry-run", [
      ["name", config.name],
      ["cron", config.cron],
      ["timezone", config.timezone],
      ["taskFile", config.taskFile],
      ["workflow", config.workflow ? "present" : "absent"],
      ["ui", config.ui ? "present" : "absent"],
      ["goal", config.goal],
      ["notify", config.notify],
    ]),
    nextRuns.length ? inlineArray("nextRuns", nextRuns.map(fmtTime), " · ") : null,
    `classification: ${config.goal != null ? "closed — self-finishes when the goal is met" : "open — runs until paused"}`,
    warning ? kvLine("warning", warning) : null,
    helpBlock(["Run `loopany new --json '{...}'` (drop --dry-run) to create the loop"]),
  );
}

/** `loopany edit` (real apply) — the updated-loop confirmation. */
function renderEditAppliedText(loopId: string, name: string, applied: string[]): string {
  return doc(
    `updated: ${scalar(name)} (${loopId})`,
    inlineArray("applied", applied),
    helpBlock([`Run \`loopany show ${loopId}\` to confirm the new config`]),
  );
}

/** `loopany edit --json '{}'` — the empty-patch no-op (feedback #3). Reports plainly
 *  that nothing changed and lists the keys an edit MAY touch, so the agent's next
 *  attempt is well-formed without having to fail to discover the envelope. */
function renderEditNoopText(loopId: string, name: string): string {
  return doc(
    `nothing to change: ${scalar(name)} (${loopId})`,
    inlineArray("editable", [...EDITABLE_LOOP_FIELDS]),
    helpBlock([`Run \`loopany show ${loopId}\` to see the current config`]),
  );
}

/** `loopany edit --dry-run` — the per-key before→after preview + rejections. */
function renderEditDryRunText(
  loopId: string,
  name: string,
  changes: Array<{ key: string; from: unknown; to: unknown }>,
  rejections: Array<{ key: string; reason: string }>,
): string {
  const header = rejections.length
    ? `dry-run: ${scalar(name)} — ${changes.length} change${changes.length === 1 ? "" : "s"} valid, ${rejections.length} rejected`
    : `dry-run: ${scalar(name)} — nothing changed`;
  return doc(
    header,
    changes.length
      ? listBlock("changes", ["key", "from", "to"], changes.map((c) => [c.key, c.from as Scalar, c.to as Scalar]))
      : "changes: none",
    rejections.length
      ? listBlock("rejections", ["key", "reason"], rejections.map((r) => [r.key, r.reason]))
      : "rejections: none",
    helpBlock([`Run \`loopany edit ${loopId} --json '{...}'\` (drop --dry-run) to apply`]),
  );
}

/** `loopany report` — the compact run-outcome confirmation (§4.6). */
function renderReportedText(status: string | undefined, state: Record<string, number | string> | undefined, hasMessage: boolean): string {
  const parts: string[] = [];
  if (status) parts.push(`status=${status}`);
  const metrics = runMetricsToken(state);
  if (metrics) parts.push(`metrics ${metrics}`);
  if (hasMessage) parts.push("message recorded");
  return `reported: ${parts.length ? parts.join(" · ") : "recorded"}`;
}

/** `loopany finish` — the goal-met confirmation, read back off the completed loop. */
function renderFinishedText(loopId: string): string {
  const loop = store.getLoop(loopId);
  if (!loop) return "finished: goal met";
  return doc(
    `finished: ${scalar(loop.name ?? loop.id)} (${loop.id}) — goal met`,
    loop.completedAt ? kvLine("completedAt", fmtTime(loop.completedAt)) : null,
    loop.completionReason ? kvLine("completionReason", loop.completionReason) : null,
  );
}

/** Indent every line of a rendered TOON block two spaces, so a typed list/detail
 *  nests under a parent top key (e.g. the `always[]`/`schedule[]` groups under
 *  `verbs:` in the in-run help). */
function indent(block: string): string {
  return block
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

// ---- per-verb `--help` (P10) --------------------------------------------------
// `<verb> --help` prints that verb's syntax + a one-line summary + concrete `help[]`
// templates. Rendered server-side so it is ROLE-AWARE for a run credential (the lease
// caps decide the availability line) and full for a device credential (owner
// authority, no availability caveats). Two maps because the run + owner verb surfaces
// barely overlap (`show`/`log` differ by scope); a verb absent from the relevant map
// has no `--help` and falls through to the caller's unknown-command handling.

interface VerbHelpSpec {
  syntax: string;
  summary: string;
  help: string[];
  /** Availability line for a RUN lease (role-aware); omitted ⇒ no availability line. */
  avail?: (lease: RunLease) => string;
}

/** Availability of a schedule/control mutation for a run: gated by `allowControl`. */
const controlAvail = (l: RunLease): string => (l.allowControl ? "available to this run" : "needs allowControl (off for this loop)");
/** Availability of a structural (set-ui/schema/workflow) verb: evolve/edit pass only. */
const gateAvail = (has: (l: RunLease) => boolean | undefined) => (l: RunLease): string =>
  has(l) ? "available to this run (evolve/edit pass)" : `evolve/edit pass only — this run is "${l.role}"`;
const alwaysAvail = (): string => "always available";

/** RUN-credential verb help (in-run `rk_` lease). */
const RUN_VERB_HELP: Record<string, VerbHelpSpec> = {
  report: {
    syntax: "report [--status new|resolved|nothing-new] [--message <s>] [--state '{\"k\":n}' | --state-file <path>]",
    summary: "record this run's outcome + metrics (state keys must match the loop's schema)",
    avail: alwaysAvail,
    help: [
      "Run `loopany report --status nothing-new` to close this run with no news",
      'Run `loopany report --status new --message "<one line>" --state \'{"drift":3}\'` to record metrics',
    ],
  },
  finish: {
    syntax: 'finish --message "<achieved>" [--reason "<one line>"]',
    summary: "declare the goal met — completes this closed loop",
    avail: (l) => (l.canFinish ? "available — declare the goal met" : `exec run on a goal (closed) loop only — this run is "${l.role}"`),
    help: ['Run `loopany finish --message "<what was achieved>" --reason "<one line>"` to complete the loop'],
  },
  show: {
    syntax: "show",
    summary: "print this loop's current config + recent state",
    avail: alwaysAvail,
    help: ["Run `loopany log` to see this loop's recent runs"],
  },
  log: {
    syntax: "log [--limit <n>] [--transcript] [--json]",
    summary: "recent run survey for this loop (session ids + metrics)",
    avail: alwaysAvail,
    help: ["Run `loopany log --transcript` to inline each run's transcript"],
  },
  reschedule: {
    syntax: "reschedule --run-at <30m|2h|ISO>",
    summary: "run once more soon, then resume the cadence (floor applies; --next is an alias)",
    avail: controlAvail,
    help: ["Run `loopany reschedule --run-at 2h` to run again in two hours"],
  },
  "set-cron": {
    syntax: 'set-cron "<5-field cron>"',
    summary: "change the cadence (floor applies)",
    avail: controlAvail,
    help: ['Run `loopany set-cron "0 7 * * 1"` to change the cadence'],
  },
  "set-ui": {
    syntax: "set-ui --file <path>",
    summary: "replace the dashboard HTML (the shim inlines the file)",
    avail: gateAvail((l) => l.canSetUi),
    help: ["Run `loopany set-ui --file dashboard.html` to replace the dashboard"],
  },
  "set-schema": {
    syntax: "set-schema --file <path>",
    summary: "declare metrics — a JSON array of {key, label?, unit?}",
    avail: gateAvail((l) => l.canSetSchema),
    help: ["Run `loopany set-schema --file schema.json` to declare the loop's metrics"],
  },
  "set-workflow": {
    syntax: "set-workflow --file <path>",
    summary: "replace the deterministic pre-stage JS",
    avail: gateAvail((l) => l.canSetWorkflow),
    help: ["Run `loopany set-workflow --file workflow.js` to replace the pre-stage"],
  },
  pause: {
    syntax: "pause",
    summary: "pause this loop (enabled=false)",
    avail: controlAvail,
    help: ["Run `loopany resume` to re-enable it"],
  },
  resume: {
    syntax: "resume",
    summary: "resume this loop (enabled=true)",
    avail: controlAvail,
    help: ["Run `loopany pause` to pause it again"],
  },
  notify: {
    syntax: "notify always|auto|never",
    summary: "set this loop's failure/success notification policy",
    avail: controlAvail,
    help: ["Run `loopany notify auto` to notify only on meaningful changes"],
  },
  "set-name": {
    syntax: 'set-name "<name>"',
    summary: "rename this loop",
    avail: controlAvail,
    help: ['Run `loopany set-name "Docs Sweep"` to rename the loop'],
  },
  "set-tz": {
    syntax: "set-tz <IANA zone>",
    summary: "set the loop's timezone (the cron fires in it)",
    avail: controlAvail,
    help: ["Run `loopany set-tz America/Los_Angeles` to change the timezone"],
  },
  "set-model": {
    syntax: "set-model <model>",
    summary: "pin the coding-agent model for this loop",
    avail: controlAvail,
    help: ["Run `loopany set-model claude-opus-4-8` to pin the model"],
  },
};
// `complete` is a documented alias of `finish` (§6.2).
RUN_VERB_HELP.complete = RUN_VERB_HELP.finish!;

/** DEVICE-credential verb help (owner `dk_` device token). */
const DEVICE_VERB_HELP: Record<string, VerbHelpSpec> = {
  new: {
    syntax: "new --json '<config>' [--dry-run]",
    summary: `create a loop (keys: ${[...EDITABLE_LOOP_FIELDS].join(", ")}; cron + taskFile|workflow required)`,
    help: [
      "Run `loopany new --json '{\"cron\":\"0 8 * * *\",\"taskFile\":\"<path>\"}'` to create a loop",
      "Run `loopany new --json '{...}' --dry-run` to validate without creating",
    ],
  },
  loops: {
    syntax: "loops",
    summary: "list every loop bound to this machine",
    help: ["Run `loopany show <id>` to see a loop's full config", "Run `loopany log <id>` to see a loop's recent runs"],
  },
  edit: {
    syntax: "edit <id> --json '<patch>' [--dry-run]",
    summary: `change a loop's config (keys: ${[...EDITABLE_LOOP_FIELDS].join(", ")})`,
    help: [
      "Run `loopany edit <id> --json '{\"cron\":\"0 7 * * 1\"}'` to change the schedule",
      "Run `loopany edit <id> --json '{...}' --dry-run` to preview the change",
    ],
  },
  show: {
    syntax: "show <id>",
    summary: "print a loop's full config + recent state",
    help: ["Run `loopany loops` to list loops on this machine", "Run `loopany log <id>` to see the loop's recent runs"],
  },
  log: {
    syntax: "log [<id>] [--limit <n>] [--transcript] [--json]",
    summary: "recent run survey for a loop (session ids + metrics)",
    help: ["Run `loopany log <id> --transcript` to inline each run's transcript", "Run `loopany log <id> --json` for the structured run rows"],
  },
};

/** Render a verb's `--help` (P10). A run lease ⇒ role-aware (availability line from
 *  the caps); no lease ⇒ the device (owner) surface. Returns undefined for a verb
 *  with no help spec, so the caller falls back to its unknown-command handling. */
function verbHelpText(verb: string, lease?: RunLease): string | undefined {
  const spec = lease ? RUN_VERB_HELP[verb] : DEVICE_VERB_HELP[verb];
  if (!spec) return undefined;
  return doc(
    kvLine("verb", verb),
    kvLine("syntax", spec.syntax),
    kvLine("summary", spec.summary),
    lease && spec.avail ? kvLine("availability", spec.avail(lease)) : null,
    helpBlock(spec.help),
  );
}

/**
 * The full editable envelope keyed EXACTLY as `edit --json` accepts (read/write
 * identity, F6/§4.1 batch 2): `id` + every EDITABLE_LOOP_FIELDS key with its raw
 * stored value (full bodies, no truncation). `show --json` emits this verbatim;
 * dropping `id` yields a no-op `edit` patch (pinned by the roundtrip test). The
 * pinned next-run OVERRIDE is keyed `runAt` (matching the edit key; the DB column
 * stays `nextRunAt`), NOT the derived read-only `nextFire` aggregate.
 */
function loopEnvelope(loop: Loop): Record<string, unknown> {
  return {
    id: loop.id,
    name: loop.name ?? null,
    cron: loop.cron,
    timezone: loop.timezone ?? null,
    notify: loop.notify,
    model: loop.model ?? null,
    allowControl: loop.allowControl,
    taskFile: loop.taskFile ?? null,
    enabled: loop.enabled,
    runAt: loop.nextRunAt ?? null,
    goal: loop.goal ?? null,
    workflow: loop.workflow ?? null,
    ui: loop.ui ?? null,
    stateSchema: loop.stateSchema ?? null,
  };
}

/** Render a large content field (ui/workflow) for the `show` detail block: `absent`
 *  when unset, the full body (scalar-quoted) under `--full`, else a presence + size
 *  hint (P3 / feedback #2 — never a char-clipped body). */
function contentField(value: string | null, full: boolean): Scalar | { raw: string } {
  if (value == null) return "absent";
  if (full) return value; // scalar() quotes the full body (newlines escaped to one line)
  return { raw: `present, ${value.length} bytes — use --full to see` };
}

/** Render the state schema STRUCTURALLY (not char-clipped): the header
 *  `stateSchema[N]{key,label,unit}:` plus one `key,label,unit` triple per field,
 *  joined by ` · `. Absent → the bare `absent` token. */
function schemaField(schema: StateField[] | null): { key: string; value: Scalar | { raw: string } } {
  if (!schema || !schema.length) return { key: "stateSchema", value: "absent" };
  const rows = schema.map((f) => [f.key, f.label ?? ABSENT, f.unit ?? ABSENT].join(",")).join(" · ");
  return { key: `stateSchema[${schema.length}]{key,label,unit}`, value: { raw: rows } };
}

/** The next cadence fire (the derived read-only aggregate), formatted in the loop's
 *  OWN timezone with a short zone name (`2026-07-13 06:00:00 PDT`) — matching how the
 *  scheduler arms it. Distinct from the writable `runAt` override (F4). */
function nextFireDisplay(cron: string, timezone: string | null): string {
  const iso = nextFires(cron, timezone, 1)[0];
  if (!iso) return "(never)";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
  } catch {
    return fmtTime(iso);
  }
}

/**
 * `loopany show` — the full editable envelope TOON (F1/F6, feedback #1/#2, §4.1).
 * The `loop:` block keys are EXACTLY `edit --json`'s keys (read/write identity),
 * then the read-only derived aggregates (`nextFire`/`classification`/`runs`). A run
 * caller (opts.allowControl/canFinish present) adds the effective `selfSchedule`/
 * `selfFinish` lines + run-appropriate help; a device caller gets owner help.
 */
function renderShowText(
  loop: Loop,
  env: Record<string, unknown>,
  totalRuns: number,
  lastExec: { phase: string; outcome: string | null; status: string | null; ts: string } | null,
  opts: { allowControl?: boolean; canFinish?: boolean; full?: boolean } = {},
): string {
  const full = opts.full === true;
  const schema = schemaField(loop.stateSchema ?? null);
  const block = detailBlock("loop", [
    ["id", env.id as Scalar],
    ["name", env.name as Scalar],
    ["cron", env.cron as Scalar],
    ["timezone", env.timezone as Scalar],
    ["notify", env.notify as Scalar],
    ["model", env.model as Scalar],
    ["allowControl", env.allowControl as Scalar],
    ["taskFile", env.taskFile as Scalar],
    ["enabled", env.enabled as Scalar],
    ["runAt", env.runAt as Scalar],
    // The setpoint: a value ⇒ CLOSED loop (finishable); em-dash ⇒ OPEN (monitor).
    ["goal", env.goal as Scalar],
    ["workflow", contentField(loop.workflow ?? null, full)],
    ["ui", contentField(loop.ui ?? null, full)],
    [schema.key, schema.value],
  ]);
  const classification =
    loop.goal != null
      ? "closed (has goal — self-finishes when the goal is met)"
      : "open (no goal — runs until paused)";
  const runsTally = lastExec
    ? `${totalRuns} total · last exec ${runOutcomeToken(lastExec)} ${fmtTime(lastExec.ts)}`
    : `${totalRuns} total`;
  // A run caller reads its EFFECTIVE capabilities; a device caller (both undefined)
  // omits these and gets the owner help below.
  const isRun = opts.allowControl !== undefined || opts.canFinish !== undefined;
  const help = isRun
    ? [
        "Run `loopany reschedule --run-at 2h` to run again sooner (then resume cadence)",
        `Run \`loopany set-cron "${loop.cron}"\` to change the cadence (floors apply)`,
        'Run `loopany report --status new --message "<one line>"` to record this run',
      ]
    : [
        `Run \`loopany show ${loop.id} --full\` to see the complete ui/workflow bodies`,
        `Run \`loopany edit ${loop.id} --json '{"cron":"0 7 * * 1"}'\` to change the schedule`,
        `Run \`loopany log ${loop.id}\` to see recent run outcomes`,
      ];
  return doc(
    block,
    kvLine("nextFire", nextFireDisplay(loop.cron, loop.timezone ?? null)),
    `classification: ${classification}`,
    `runs: ${runsTally}`,
    // EFFECTIVE run capabilities (camelCase, replacing the old self-schedule/
    // self-finish display keys): whether this run may self-reschedule, and whether it
    // may declare the goal met (exec-on-closed-loop).
    opts.allowControl !== undefined ? kvLine("selfSchedule", opts.allowControl ? "allowed" : "off") : null,
    opts.canFinish !== undefined ? kvLine("selfFinish", opts.canFinish ? "allowed" : "off") : null,
    helpBlock(help),
  );
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

/** Structural equality for an editLoop before→after comparison: null and undefined
 *  are equal (an absent field re-fed as null is unchanged); objects/arrays compare by
 *  their JSON serialization (stateSchema is a small array); everything else by `===`.
 *  Powers the no-op filter that makes the `show --json` → `edit` roundtrip a no-op. */
function sameLoopValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Bound a value for the dry-run before→after preview: a long content string
 *  (workflow JS / dashboard HTML) is clipped so the response stays small; other
 *  scalars/arrays pass through as-is (they're already small). */
function clipPreview(v: unknown): unknown {
  const CAP = 200;
  if (typeof v === "string" && v.length > CAP) return v.slice(0, CAP) + `… (+${v.length - CAP} chars)`;
  return v;
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

/** Probe the cadence IN the loop's timezone (fire times shift with it) — the tz,
 *  when given, must already be validated (validTimezone) so a croner throw here
 *  always means a bad expression, not a bad zone. */
function validCadence(cron: string, timezone?: string | null): Applied {
  try {
    const c = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
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

/** Milliseconds between a cron's next two fires, probed IN the loop's timezone
 *  (fire times shift with it) — the self-schedule cron floor's adjacent-interval
 *  check. Null when the expression can't fire twice / is invalid (the caller has
 *  already run validCadence, so null here just skips the floor). */
function cronIntervalMs(cron: string, timezone?: string | null): number | null {
  try {
    const c = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
    const a = c.nextRun();
    const b = a ? c.nextRun(a) : null;
    c.stop();
    if (!a || !b) return null;
    return b.getTime() - a.getTime();
  } catch {
    return null;
  }
}

/** The next N fire times of a cron, probed IN the loop's timezone (fire times shift
 *  with it — matching how the scheduler arms the loop), as ISO strings. Empty when
 *  the expression is invalid (the caller has already run validCadence). Powers the
 *  `--dry-run` fire preview. */
export function nextFires(cron: string, timezone: string | null | undefined, n: number): string[] {
  try {
    const c = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
    const out: string[] = [];
    let prev: Date | undefined;
    for (let i = 0; i < n; i++) {
      const next = prev ? c.nextRun(prev) : c.nextRun();
      if (!next) break;
      out.push(next.toISOString());
      prev = next;
    }
    c.stop();
    return out;
  } catch {
    return [];
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
