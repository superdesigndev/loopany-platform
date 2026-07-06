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
  registerRunToken,
  resolveRunToken,
  revokeRunToken,
  revokeRunTokensForRun,
  markRunTokensReclaimed,
  pruneReclaimedRunTokens,
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
    // Drop reclaimed run tokens whose wake-report grace has elapsed (bounded memory).
    pruneReclaimedRunTokens(now);
  }

  /** Finalize one stuck run as an error (the sweep's reclaim path): persist the
   *  failure, MARK any run token for it reclaimed (rather than revoking it
   *  outright), clear an evolve marker, and surface the failure through the anti-
   *  spam'd notify path.
   *
   *  Why mark, not revoke: the usual cause is a laptop that merely fell ASLEEP
   *  mid-run. When it wakes, claude finishes and the daemon delivers the real
   *  (often SUCCESSFUL) result. Revoking the token here would 401 that late
   *  report and strand the run as a permanent false failure with its message
   *  lost (the investigated bug). So the token survives a bounded grace window
   *  (`RECLAIM_GRACE_MS`) during which exactly ONE late wake-report may reconcile
   *  the run — see `report()`'s reclaimed branch. The credential is still bounded:
   *  agent-api mutations are refused while reclaimed, and the reconciliation
   *  revokes the token single-shot. A pending run (no token minted yet) is
   *  unaffected — the mark is a no-op there. */
  private reclaimRun(run: Run, reason: string): void {
    store.updateRun(run.id, { phase: "error", outcome: "error", error: reason, ts: nowIso() });
    markRunTokensReclaimed(run.id);
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
      const token = registerRunToken({
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
    // a loop's standing brief lives in its task file's Spec, and the run message is a
    // server-composed static trigger (see buildExecTask). So a loop needs either a
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
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          config: {
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
          },
          timezone: timezone ?? null,
          nextRuns: nextFires(cron, timezone, 3),
          classification: goal != null ? "closed" : "open",
          classificationText:
            goal != null
              ? "closed (has goal): will self-finish when the goal is met"
              : "open: runs until paused",
          ...(uiWarning ? { warning: uiWarning } : {}),
        },
      };
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
    if (uiDropped) log.warn({ machineId, loopId: loop.id }, "createLoop: provided ui dropped — loop created without a dashboard");
    log.info({ machineId, loopId: loop.id, agent, ui: ui != null }, "createLoop: created from a coding agent");
    // Echo `ui` presence (like dry-run) + a warning when a provided dashboard was
    // dropped, so the CLI/response can surface it — never a silent no-dashboard.
    return { status: 200, body: { ok: true, id: loop.id, name, ui: ui != null, ...(uiWarning ? { warning: uiWarning } : {}) } };
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
   * outcome, its claude-code `sessionId`, its reported metrics (`state`/`sample`),
   * and a clipped transcript so the create/update/evolve flows can see how past runs
   * actually went before reshaping the loop.
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
        /** Claude-reported spend (USD estimate) so `loopany log` surfaces run cost. */
        costUsd: r.costUsd ?? null,
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
        },
      };
    }

    // Real path: a validation rejection fails loudly (first one, preserving the
    // per-field message + order the checks run in).
    if (rejections.length) return { status: 400, body: { error: rejections[0]!.reason } };
    if (Object.keys(update).length === 0) return { status: 400, body: { error: "nothing to change" } };

    const updated = store.updateLoop(id, update);
    if (!updated) return { status: 404, body: { error: "loop not found" } };
    // Re-arm the scheduler: an enabled flip toggles add/remove, any other change re-adds.
    if (updated.enabled) this.scheduler.addLoop(updated);
    else this.scheduler.removeLoop(updated.id);
    log.info({ machineId, loopId: id, fields: Object.keys(update) }, "editLoop: applied");
    return { status: 200, body: { ok: true, id: updated.id, name: updated.name ?? updated.id, applied: Object.keys(update) } };
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
    const set = (key: string, to: unknown, from: unknown): void => {
      (update as Record<string, unknown>)[key] = to;
      changes.push({ key, from: clipPreview(from), to: clipPreview(to) });
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
      const when = parseWhen(String(p.runAt));
      if (!when) rejections.push({ key: "runAt", reason: "run-at must be 30m|2h|1d or a future ISO time" });
      else if (Date.parse(when) > Date.now() + MAX_NEXT_MS) rejections.push({ key: "runAt", reason: "run-at too far in the future (>30d)" });
      else set("nextRunAt", when, loop.nextRunAt);
    }
    // Content fields reuse the SAME validators the run-token set-* path uses, so
    // the owner edit surface can't drift from the evolve/edit run behavior. They
    // also get the same wire clip discipline as createLoop's workflow.
    if (p.workflow !== undefined) {
      if (typeof p.workflow !== "string") rejections.push({ key: "workflow", reason: "workflow must be a string (the pre-stage JS)" });
      else {
        const v = this.validateWorkflow(p.workflow.slice(0, WIRE_TEXT_CAP));
        if (!v.ok) rejections.push({ key: "workflow", reason: v.detail });
        else set("workflow", v.value, loop.workflow);
      }
    }
    if (p.ui !== undefined) {
      if (typeof p.ui !== "string") rejections.push({ key: "ui", reason: "ui must be a string (the dashboard HTML)" });
      else set("ui", this.validateUi(p.ui.slice(0, WIRE_TEXT_CAP)).value, loop.ui);
    }
    if (p.stateSchema !== undefined) {
      const v = this.validateSchema(loop.id, p.stateSchema);
      if (!v.ok) rejections.push({ key: "stateSchema", reason: v.detail });
      else set("stateSchema", v.value, loop.stateSchema);
    }
    return { update, changes, rejections };
  }

  /** Read a New-loop claim's result (the web dialog polls this while waiting). */
  claimStatus(token: string): ClaimResult | undefined {
    return readClaim(token);
  }

  // ---- POST /agent-api/loop ----

  agentApi(runToken: string, argv: string[]): HttpResult {
    const slot = resolveRunToken(runToken);
    if (!slot) return { status: 401, body: { text: "loopany: invalid or expired token", exitCode: 1 } };
    // The run was already reclaimed by the server (the machine was likely asleep).
    // Its token lives on only to accept ONE reconciling wake-report via
    // /machine/report — never further agent-api mutations (reschedule/set-*/finish).
    if (slot.reclaimedAt != null) {
      return {
        status: 409,
        body: { text: "loopany: this run was reclaimed by the server (the machine was likely asleep); its result is delivered via the final report", exitCode: 1 },
      };
    }
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
      /** Claude-reported cost/usage for this run (usd + token counts). */
      cost?: unknown;
    },
  ): HttpResult {
    const slot = resolveRunToken(runToken);
    if (!slot) return { status: 401, body: { error: "invalid or expired token" } };
    const ok = !!body.ok;

    const run = store.getRun(slot.runId);
    // The user stopped this run while the machine was still working — keep it
    // canceled, and bail BEFORE any loop-level write: a late report must not
    // advance the workflow cursor / task file (the next run would silently skip
    // data whose output the user never saw), nor flip the phase to done/error.
    if (run?.phase === "canceled") {
      revokeRunToken(runToken);
      // Clear a pending edit even if its run was canceled, so it doesn't re-fire —
      // and symmetrically clear an evolve marker (evolveDue), or the canceled
      // evolve pass re-fires on the very next tick.
      if (slot.role === "edit") this.scheduler.finishEdit(slot.loopId);
      if (slot.role === "evolve") this.scheduler.finishEvolution(slot.loopId);
      log.info({ runId: slot.runId }, "report: ignored (run was canceled)");
      return { status: 200, body: { ok: true } };
    }

    // The run already finalized itself via `loopany finish` (phase "done"): the
    // daemon's normal post-run report still arrives with the precise durationMs +
    // sessionId (+ transcript/artifacts), which finish couldn't know mid-run. ENRICH
    // the already-completed run with those so a finished run's log matches a reported
    // one — but do NOT re-stamp the loop, re-notify, advance the cursor, or re-
    // snapshot (finish did all of that). Then revoke the token: finish deliberately
    // left it live for exactly this one enriching report.
    if (run?.phase === "done") {
      const enrichArtifacts = coerceArtifacts(body.artifacts);
      const enrichTranscript = coerceTranscript(body.transcript);
      store.updateRun(slot.runId, {
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId.slice(0, SESSION_ID_CAP) } : {}),
        ...(enrichArtifacts ? { artifacts: enrichArtifacts } : {}),
        ...(enrichTranscript ? { transcript: enrichTranscript } : {}),
        // Cost, like durationMs, is only known post-run — enrich the finished row.
        ...coerceCost(body.cost),
      });
      if (typeof body.taskFileContent === "string") {
        store.updateLoop(slot.loopId, {
          taskFileContent: body.taskFileContent.slice(0, WIRE_TEXT_CAP),
          taskFileSyncedAt: nowIso(),
        });
      }
      revokeRunToken(runToken);
      log.info({ runId: slot.runId }, "report: enriched a finished run (durationMs/sessionId)");
      return { status: 200, body: { ok: true } };
    }

    // ── Late wake-report for a sweep-RECLAIMED run ─────────────────────────────
    // The machine went unreachable (asleep/offline) mid-run, so the sweep reclaimed
    // this run as a false `error` and pushed a machine-offline alert — but kept the
    // token alive (reclaimed) for the grace window instead of revoking it. The
    // daemon has now resumed and delivered the run's REAL result. Honor exactly ONE
    // such late report to correct the record, then revoke the token single-shot
    // (like the finish→enrich handshake). Recognized by the slot's `reclaimedAt`
    // stamp — set ONLY by `reclaimRun` for the three machine-availability reasons.
    if (run?.phase === "error" && slot.reclaimedAt != null) {
      const artifacts = coerceArtifacts(body.artifacts);
      const transcript = coerceTranscript(body.transcript);
      const rawMessage = body.message !== undefined ? body.message : body.finalText;
      const message = typeof rawMessage === "string" ? rawMessage.slice(0, MESSAGE_CAP) : undefined;
      const claimedOutcome = RUN_OUTCOMES.has(body.outcome as string) ? body.outcome : undefined;
      if (typeof body.taskFileContent === "string") {
        store.updateLoop(slot.loopId, {
          taskFileContent: body.taskFileContent.slice(0, WIRE_TEXT_CAP),
          taskFileSyncedAt: nowIso(),
        });
      }
      const finalized = store.updateRun(slot.runId, {
        phase: ok ? "done" : "error",
        outcome: ok ? claimedOutcome ?? (slot.role === "evolve" ? "evolve" : "exec") : "error",
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId.slice(0, SESSION_ID_CAP) } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(transcript ? { transcript } : {}),
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
      revokeRunToken(runToken);
      // Re-capture the end-state snapshot (best-effort), same as the normal path.
      try {
        store.putRunSnapshot(slot.runId, slot.loopId, store.buildLoopManifest(slot.loopId));
        store.pruneRunSnapshots(slot.loopId, snapshotRetention());
      } catch (err) {
        log.warn({ runId: slot.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
      }
      if (ok && slot.role !== "evolve" && slot.role !== "edit") {
        // The failure alert was WRONG — the run actually succeeded. Flipping the row
        // to `done` already corrects the failure streak (it's derived from persisted
        // rows), so a later tick won't count this. Retract by pushing the real result
        // (a cheap, honest correction), gated by the loop's normal notify policy.
        const loop = store.getLoop(slot.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          void this.notify(loop, finalized.message);
        }
      }
      // A genuine late FAILURE is recorded honestly but does NOT re-notify: the
      // reclaim already alerted the user once for this run.
      log.info(
        { runId: slot.runId, ok, reclaimed: true },
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
        log.warn({ runId: slot.runId, bytes: serialized!.length }, "report: cursor over size cap — ignored");
        cursor = undefined;
      }
    }
    if (cursor !== undefined) store.updateLoop(slot.loopId, { state: cursor });

    // Sync the machine's task file onto the loop (untrusted wire input — clip
    // defensively even though the daemon already caps it).
    if (typeof body.taskFileContent === "string") {
      store.updateLoop(slot.loopId, {
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
    const finalized = store.updateRun(slot.runId, {
      phase: ok ? "done" : "error",
      outcome: ok ? claimedOutcome ?? (slot.role === "evolve" ? "evolve" : "exec") : "error",
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

  /**
   * The `loopany finish` verb's effect (closed-loop self-termination): record THIS
   * run as an ordinary success (phase=done, outcome=exec, status=resolved) with the
   * run's summary/metrics, then stamp the loop terminal (completedAt=now,
   * completionReason, enabled=false), remove it from the scheduler, capture the end-
   * state snapshot, and fire a completion notification unless notify=never. Gated
   * upstream by slot.canFinish (exec-on-closed-loop only).
   *
   * TOCTOU guard: canFinish was minted at poll; the owner may have CLEARED the goal
   * since (editLoop {goal:null}) — completing then would violate the invariant
   * "completedAt != null implies goal != null". So re-read the loop and refuse with
   * a clear error when it's no longer a closed loop. Nothing is stamped.
   *
   * The run token is NOT revoked here: finish can't know the run's precise durationMs
   * / sessionId mid-run, so it leaves the token live for exactly ONE enriching
   * post-run report (see report()'s phase==="done" branch), which records those and
   * revokes. Because the token stays live, a second `finish` on the same run is
   * possible — so this ALSO refuses when the loop is already completed
   * (completedAt != null), keeping finish single-shot (no re-stamp, no re-snapshot,
   * no re-notify). Double-notify/double-finalize stay impossible — both this guard
   * and report()'s phase==="done" branch never re-stamp or re-notify.
   */
  private finishLoop(
    slot: RunSlot,
    { message, reason, state }: { message?: string; reason: string | null; state?: Record<string, number | string> },
  ): Applied {
    // TOCTOU: refuse if the loop is no longer closed (goal cleared since poll).
    const current = store.getLoop(slot.loopId);
    if (!current || current.goal == null) {
      return { ok: false, detail: "this loop no longer has a goal to finish — its goal was cleared since this run started" };
    }
    // Idempotency: the run token stays live for the enriching report, so a second
    // `finish` on the same run is possible — refuse it so completion stays single-shot.
    if (current.completedAt != null) {
      return { ok: false, detail: "this loop is already finished" };
    }
    const ts = nowIso();
    // Record durationMs server-side from the run's claim/running timestamp so a
    // finished run always carries a duration even if the daemon's enriching report
    // is lost; the enriching report overrides it with the precise value.
    const run = store.getRun(slot.runId);
    const durationMs = run ? Date.now() - Date.parse(run.ts) : NaN;
    store.updateRun(slot.runId, {
      phase: "done",
      outcome: "exec",
      status: "resolved",
      ...(message !== undefined ? { message } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
      progress: null,
      ts,
    });
    const loop = store.updateLoop(slot.loopId, { completedAt: ts, completionReason: reason, enabled: false });
    this.scheduler.removeLoop(slot.loopId);
    // Snapshot the loop's end-state (Phase 3 diff baseline), best-effort like report().
    try {
      store.putRunSnapshot(slot.runId, slot.loopId, store.buildLoopManifest(slot.loopId));
      store.pruneRunSnapshots(slot.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: slot.runId, err: err instanceof Error ? err.message : String(err) }, "finish: snapshot capture failed");
    }
    // Completion is a distinct terminal event — notify unless the user opted out
    // of all pushes (notify: "never"). Best-effort (void), like the report path.
    if (loop && loop.notify !== "never") {
      void this.notify(loop, completionMessage(reason, message));
    }
    log.info({ runId: slot.runId, loopId: slot.loopId }, "finish: loop completed");
    return { ok: true, detail: "loop finished — goal met, loop completed" };
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
          // Clipped to the same cap the report finalText fallback enforces.
          ...(str("message") !== undefined ? { message: str("message")!.slice(0, MESSAGE_CAP) } : {}),
          ...(str("sample") !== undefined ? { sample: Number(str("sample")) } : {}),
          ...(state !== undefined ? { state } : {}),
        });
        return { code: 200, text: "reported" };
      }
      case "show":
        return { code: 200, text: this.describe(slot.loopId, slot.allowControl, slot.canFinish) };
      case "finish":
      case "complete": {
        if (!slot.canFinish) {
          // canFinish is false both for OPEN loops (no goal) and for evolve/edit
          // runs — give the right message for each. The open-loop case is primary.
          const loop = store.getLoop(slot.loopId);
          if (!loop || loop.goal == null) {
            return { code: 403, text: "loopany: this loop has no goal to finish (it's an open/monitor loop)" };
          }
          return { code: 403, text: "loopany: only an exec run may finish a loop" };
        }
        // Optional --state, validated exactly like the report verb.
        const rawState = str("state") ?? str("state-content");
        let state: Record<string, number | string> | undefined;
        if (rawState !== undefined) {
          const loop = store.getLoop(slot.loopId);
          const v = validateState(rawState, loop?.stateSchema ?? undefined);
          if (!v.ok) return { code: 400, text: `loopany: ${v.error}` };
          state = v.value;
        }
        const message = str("message")?.slice(0, MESSAGE_CAP);
        const reason = str("reason")?.slice(0, MESSAGE_CAP) ?? null;
        const r = this.finishLoop(slot, { message, reason, state });
        return r.ok ? { code: 200, text: r.detail ?? "finished" } : { code: 400, text: `loopany: ${r.detail ?? "rejected"}` };
      }
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
      ...(slot.canFinish
        ? ['  finish  --message "<achieved>" [--reason "<one line>"]  declare the goal met — completes this loop']
        : []),
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

  // `allowControl` is the EFFECTIVE self-schedule capability of the run calling
  // `show` (the run slot's `structural || loop.allowControl`), not just the loop
  // flag — so an evolve/edit pass reads as allowed while a normal exec run reflects
  // the loop's flag. The standing exec prompt's §4 tells the run to consult this line
  // before attempting reschedule/set-cron. Undefined ⇒ omit the line (non-run callers).
  private describe(loopId: string, allowControl?: boolean, canFinish?: boolean): string {
    const loop = store.getLoop(loopId);
    if (!loop) return "loop not found";
    let next = "?";
    try {
      // In the loop's timezone (matching how the scheduler actually arms it) —
      // without it, `next` reads wrong for every non-server-tz loop.
      const probe = new Cron(loop.cron, { paused: true, ...(loop.timezone ? { timezone: loop.timezone } : {}) });
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
      // The setpoint: a value ⇒ CLOSED loop (finishable); "—" ⇒ OPEN (monitor).
      `goal: ${loop.goal ?? "—"}`,
    ];
    if (allowControl !== undefined) lines.push(`self-schedule: ${allowControl ? "allowed" : "off"}`);
    // Whether THIS run may declare the goal met (exec-on-closed-loop). Mirrors the
    // self-schedule line's run-gating (omitted for non-run callers).
    if (canFinish !== undefined) lines.push(`self-finish: ${canFinish ? "allowed" : "off"}`);
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
