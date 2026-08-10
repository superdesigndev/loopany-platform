/**
 * Machine gateway - the run-lifecycle core of the HTTP surface the daemon talks
 * to (poll transport: short-poll while a run is in flight, opt-in server-held
 * long-poll while idle). Framework-agnostic like the rest of the gateway
 * (return `{ status, body }` so the methods can be mounted on a plain http
 * server or TanStack server routes):
 *
 *   POST /api/machine/poll   (Bearer device token) → claim pending runs, deliver
 *   POST /machine/report     (Bearer run token)    → finalize a run
 *
 * plus the owner verbs (createLoop/listLoops/editLoop/loopLog) and retention.
 * Also exposes `dispatcher` (a `Dispatcher` for the Scheduler: "is the machine
 * online?") and `sweep()` (mark stale machines offline, reclaim stuck runs).
 * The CLI verb dispatch (`/api/machine/cli` + `/agent-api/loop`) lives in
 * `gateway/cli.ts` (`CliGateway`), which reuses this class's methods; the
 * shared ui/workflow/schema validators live in `gateway/validate.ts`.
 */
import { Cron } from "croner";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { CodingAgent, Loop, NewLoop, Run, RunArtifact, RunRole, RunUsage, TranscriptStep } from "../db/schema.js";
import { CODING_AGENTS, coerceCodingAgent } from "../types.js";
import type { Scheduler } from "../scheduler/index.js";
import { buildDelivery, type Delivery } from "./delivery.js";
import { autopauseMessage, completionMessage, deferredMessage, dispatchNotification, failureMessage, shouldNotify, shouldNotifyFailure } from "./notify.js";
import { createBlobStore, type BlobStore } from "./blobstore.js";
import { maintainStorage, type MaintainResult } from "./retention.js";
import { machinePresence } from "../lib/machinePresence.js";
import { loginGateEnabled } from "../lib/loginGate.js";
import { snapshotRetention } from "../env.js";
import {
  machineIdFromToken,
  isDeviceTokenShape,
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
import {
  countLine,
  detailBlock,
  doc,
  emptyList,
  helpBlock,
  inlineArray,
  kvLine,
  listBlock,
  scalar,
  truncate,
  type Scalar,
} from "./toon.js";
import { validateSchema, validateUi, validateWorkflow } from "./validate.js";
import { clipText, nowIso, stripNul, WIRE_TEXT_CAP, type HttpResult } from "./http.js";

const log = logger.child({ mod: "gateway" });

export const ONLINE_TTL_MS = 30_000;
/** Circuit breaker: auto-pause a loop after this many CONSECUTIVE failed exec
 *  runs (`skipped` is transparent — the streak counts only phase `error`). A
 *  loop failing every tick burns credits and attention until a human notices
 *  (the anti-spam alert cadence means most failures are silent); past this bar
 *  the honest move is to stop the bleeding and say so once. 0 disables. */
const AUTOPAUSE_STREAK = Math.max(0, Number(process.env.LOOPANY_FAILURE_AUTOPAUSE_STREAK ?? 10));

/** How long a DEFERRED pending run (machine asleep/offline at fire time) stays
 *  claimable before it retires as `skipped`. Generous on purpose — the next cron
 *  fire usually supersedes it long before this; the horizon only bounds a loop
 *  whose machine never comes back (or that can't fire again, e.g. paused). */
const DEFERRED_MAX_MS = 7 * 86_400_000;
/** Progress label stamped on a deferred pending run — doubles as the one-shot
 *  dedup marker for the offline note and as a "waiting" hint in the UI. */
const DEFERRED_LABEL = "deferred - machine offline";
/** A claimed run that never reports within this window is reclaimed as timed out. */
const RUN_TIMEOUT_MS = Number(process.env.LOOPANY_RUN_TIMEOUT_MS || 20 * 60_000);
/** `runAt`/`reschedule` horizon - shared by the owner edit path here and the
 *  run-token reschedule path in `cli.ts`. */
export const MAX_NEXT_MS = 30 * 86_400_000;
/** The ONLY keys an owner `editLoop` patch may touch. A key outside this set is
 *  rejected (400) rather than silently ignored, so a `--json` typo fails loudly
 *  and identity/ownership columns (id/teamId/userId/machineId/timestamps) can
 *  never be patched over the device-token edit surface. Exported for `cli.ts`
 *  (the `new`/`edit` verb help lists these keys). */
export const EDITABLE_LOOP_FIELDS = new Set([
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
  "agent",
]);
const MIN_INTERVAL_MS = 60_000;
const MAX_ARTIFACTS = 200;
const MAX_TRANSCRIPT_STEPS = 200;
const STEP_FIELD_MAX = 4000;
/** A workflow cursor bigger than this (serialized) is ignored rather than persisted
 *  onto the loop row — the run itself still records normally. */
const CURSOR_CAP = 256 * 1024;
/** Run messages (report --message / workflow direct message / finalText fallback).
 *  Run errors share the same cap. Exported for `cli.ts` (the report/finish verbs
 *  clip to the same budget). */
export const MESSAGE_CAP = 2000;
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
/** How often the poll hot path re-stamps `machines.lastSeen`. Only the sweep
 *  (ONLINE_TTL_MS granularity) and presence reads consume the stamp, so an
 *  every-poll UPDATE is pure write amplification on Postgres — refresh at 10s
 *  and an idle poll becomes read-only, with worst-case staleness well inside
 *  the 30s TTL (max stamp gap = refresh + one poll interval). */
const LAST_SEEN_REFRESH_MS = 10_000;
/** How long an opted-in poll (`wait:true`) is held open for work before returning
 *  empty. Bounded under the daemon's 30s fetch timeout AND under ONLINE_TTL_MS
 *  (with the end-of-wait re-stamp) so a parked long-poll never looks offline. */
const LONG_POLL_WAIT_MS = 20_000;
/** Watch-set cache TTL: the per-poll `loopsForMachine` rebuild is served from a
 *  short per-machine cache. Any delivery (the run may belong to a brand-new loop)
 *  and every gateway create/edit invalidates early, so a new or re-pathed loop
 *  folder is watched promptly; slower write paths are covered by the TTL. */
const WATCH_CACHE_TTL_MS = 15_000;
/** The run outcomes a report may claim (untrusted wire input; anything else falls
 *  back to the role default). Mirrors the runs.outcome enum minus "error", which
 *  only the server assigns. */
const RUN_OUTCOMES = new Set(["direct", "silent", "exec", "evolve"]);
// Same content-status vocabulary an agent sets via `loopany report --status`.
const RUN_STATUSES = new Set(["new", "resolved", "nothing-new"]);

/** `loopany log`: how many recent runs to return, and the per-run transcript cap.
 *  The on-machine agent wants recent history before editing/evolving — not an
 *  unbounded dump — so default to a handful of runs and clip each transcript.
 *  LOG_RUNS_DEFAULT is exported for `cli.ts` (`describe`'s recent-run window). */
export const LOG_RUNS_DEFAULT = 8;
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
      out.push({ path: clipText(p, 1024), kind: k });
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
  // Resume-recovery attempt count (daemon batch: transient-failure resume). Rides
  // the wire OUTSIDE `cost` (a body-level field), so callers pass it explicitly.
  tok("attempts", c.attempts);
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
    if (typeof text === "string") step.text = clipText(text, STEP_FIELD_MAX);
    if (typeof name === "string") step.name = clipText(name, 200);
    if (typeof input === "string") step.input = clipText(input, STEP_FIELD_MAX);
    out.push(step);
    if (out.length >= MAX_TRANSCRIPT_STEPS) break;
  }
  return out.length ? out : undefined;
}

/** One entry of the poll response's watch set (the daemon resolves the folder). */
interface WatchEntry {
  loopId: string;
  workdir: string | null;
  taskFile: string | null;
}

export class MachineGateway {
  constructor(
    /** Public (not private): `CliGateway.applyMutation` re-arms it after a
     *  run-token schedule mutation. */
    readonly scheduler: Scheduler,
    /** Artifact blob byte store (R2 in prod; injectable in-memory store for tests).
     *  Only `maintainStorage` (retention/GC) reads it here - the byte-ingress
     *  methods live on `ArtifactSync` (`sync.ts`), and boot hands BOTH classes
     *  the same instance. */
    private readonly blobStore: BlobStore = createBlobStore(),
    /** Push dispatcher — injectable (like blobStore) so tests observe notifications
     *  without a network call; defaults to the real per-channel `dispatchNotification`. */
    private readonly notify: (loop: Loop, message: string) => Promise<void> = dispatchNotification,
  ) {}

  /** In-flight latch: the maintenance pass is sequential and the first post-deploy
   *  backlog reclamation can overrun the interval, so a fresh tick skips rather than
   *  running a second pass concurrently (idempotent but wasteful + double-counts). */
  private maintenanceRunning = false;

  /** Fire-and-forget push through the injected notifier, rejection-guarded: the
   *  real dispatchNotification never lets its network call throw, but its leading
   *  store read can reject (transient DB error) - and every caller is a bare
   *  fire-and-forget off a hot path, where an escaped rejection is process-fatal
   *  under Node's default unhandled-rejection policy. */
  private pushNotify(loop: Loop, message: string): void {
    void this.notify(loop, message).catch((err) => log.warn({ loop: loop.id, err: String(err) }, "notify failed"));
  }

  /**
   * Alert the user that an exec run FAILED (error / timeout / machine-offline),
   * through the loop's chosen channel, gated by the anti-spam streak policy
   * (`shouldNotifyFailure` over `store.execFailureStreak`). Evolve/edit runs are
   * internal — they never produce user-facing failure noise. Best-effort + non-
   * throwing: the run's error is already on the dashboard regardless. Call AFTER
   * the run row has been finalized to `error`, so the streak count includes it.
   */
  private async notifyRunFailure(loopId: string, role: RunRole, reason: string | null): Promise<void> {
    if (role !== "exec") return;
    const loop = await store.getLoop(loopId);
    if (!loop) return;
    const streak = await store.execFailureStreak(loopId);
    // Circuit breaker BEFORE the alert: at the threshold the loop is paused
    // (enabled=false, unscheduled) and the single autopause note SUBSUMES the
    // failure alert — pausing stops the run stream, so this is the last push
    // until a human re-enables it. A plain pause: re-enabling resumes as usual.
    if (AUTOPAUSE_STREAK > 0 && streak >= AUTOPAUSE_STREAK && loop.enabled) {
      await store.updateLoop(loopId, { enabled: false });
      this.scheduler.removeLoop(loopId);
      log.warn({ loopId, streak }, "circuit breaker: auto-paused after consecutive exec failures");
      if (loop.notify !== "never") this.pushNotify(loop, autopauseMessage(streak));
      return;
    }
    if (shouldNotifyFailure(loop.notify, streak)) {
      this.pushNotify(loop, failureMessage(reason));
    }
  }

  /**
   * Dispatcher for the Scheduler. The pending run row IS the queue (the daemon's
   * next poll claims it, so nothing is ever lost); dispatch additionally WAKES
   * the machine's parked long-poll, so an opted-in idle daemon claims the run
   * immediately instead of on its next cadence tick.
   */
  readonly dispatcher = {
    dispatch: (loop: Loop): void => this.wakeMachine(loop.machineId),
  };

  /** One parked long-poll waiter per machine (the pidfile enforces one daemon).
   *  The stored settle fn resolves `true` on wake (new pending run) and `false`
   *  on timeout / supersede / cancel, then disarms itself. In-memory like the
   *  run-lease table: a deploy drops parked waiters, and the daemon just re-polls. */
  private readonly pollWaiters = new Map<string, (woken: boolean) => void>();

  /** Per-machine watch-set cache (TTL + explicit invalidation) — the poll hot
   *  path serves the watch list from here instead of rebuilding it every poll. */
  private readonly watchCache = new Map<string, { at: number; digest: string; watch: WatchEntry[] }>();

  /** Resolve (and disarm) a machine's parked long-poll waiter, if any. */
  private wakeMachine(machineId: string): void {
    this.pollWaiters.get(machineId)?.(true);
  }

  /** Drop a machine's cached watch set (its loop bindings/paths just changed). */
  private invalidateWatch(machineId: string): void {
    this.watchCache.delete(machineId);
  }

  /** Arm this machine's long-poll waiter: the promise resolves `true` when
   *  `wakeMachine` fires (a run went pending), `false` on timeout or cancel.
   *  A pre-existing waiter is superseded (woken) first — a dangling held
   *  request must never strand a newer one. */
  private armPollWaiter(machineId: string, waitMs: number): { promise: Promise<boolean>; cancel: () => void } {
    this.pollWaiters.get(machineId)?.(true);
    let settle!: (woken: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => settle(false), waitMs);
      timer.unref?.();
      settle = (woken: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.pollWaiters.get(machineId) === settle) this.pollWaiters.delete(machineId);
        resolve(woken);
      };
      this.pollWaiters.set(machineId, settle);
    });
    return { promise, cancel: () => settle(false) };
  }

  /**
   * Periodic maintenance: mark stale machines offline, and reclaim stuck runs.
   * A RUNNING run that went silent is reclaimed as timed out; a PENDING run on
   * an OFFLINE machine is NOT failed — it is held as a deferred catch-up (the
   * pending row is the durable inbox; the daemon's next poll claims it, and the
   * next cron fire supersedes it as `skipped`), bounded by DEFERRED_MAX_MS.
   * Only a pending run a healthy ONLINE machine never claims becomes an error.
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const m of await store.listMachines()) {
      if (m.online && (!m.lastSeen || now - Date.parse(m.lastSeen) > ONLINE_TTL_MS)) {
        await store.updateMachine(m.id, { online: false });
      }
    }
    for (const run of await store.openRuns()) {
      const age = now - Date.parse(run.ts);
      if (run.phase === "pending") {
        const machine = await store.getMachine(run.machineId);
        if (machine?.online) {
          // An online daemon claims pending runs on its next poll (seconds) —
          // and a busy machine clears its own queue — so age here means the
          // delivery is wedged (never claimable), a real anomaly.
          if (age > RUN_TIMEOUT_MS) await this.reclaimRun(run, "run never claimed");
        } else if (age > DEFERRED_MAX_MS) {
          // The machine never came back inside the catch-up horizon — retire
          // the queue slot honestly: skipped, not failed, no alert.
          await store.supersedePendingRun(run.id, "skipped - the machine stayed offline past the catch-up window");
        } else {
          // DEFERRED, not failed: the pending row IS the durable inbox — the
          // daemon's next poll claims it on reconnect (catch-up), and the next
          // cron fire supersedes it (scheduler), so the queue stays depth-1.
          // Alarm policy mirrors presence: asleep (<6h) is the common calm case
          // and stays fully silent; a genuinely OFFLINE machine gets ONE calm
          // note per deferred exec run (the progress label doubles as the
          // dedup stamp and as a "waiting" hint in the UI).
          const presence = machinePresence(machine?.online ?? false, machine?.lastSeen ?? null, now);
          if (presence === "offline" && run.role === "exec" && run.progress?.label !== DEFERRED_LABEL) {
            await store.updateRun(run.id, { progress: { step: 0, label: DEFERRED_LABEL, at: nowIso() } });
            const loop = await store.getLoop(run.loopId);
            if (loop && loop.notify !== "never") this.pushNotify(loop, deferredMessage());
          }
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
          await this.reclaimRun(run, "machine timed out / disconnected");
        }
      }
    }
    // Drop terminal-grace leases whose wake-report window has elapsed (bounded memory).
    await pruneExpiredLeases(now);
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
  private async reclaimRun(run: Run, reason: string): Promise<void> {
    await store.updateRun(run.id, { phase: "error", outcome: "error", error: reason, ts: nowIso() });
    await terminalizeLease(run.id);
    if (run.role === "evolve") await this.scheduler.finishEvolution(run.loopId);
    await this.notifyRunFailure(run.loopId, run.role, reason);
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

  async poll(
    deviceToken: string,
    info?: { host?: string; platform?: string; arch?: string; version?: string },
    progress?: Array<{ runId: string; step: number; label: string }>,
    /** The daemon's echo of the last watch digest it applied — matching ⇒ the
     *  watch array is omitted from the response (an old daemon never echoes). */
    watchDigest?: string,
  ): Promise<HttpResult> {
    // Reject malformed tokens (empty / wrong prefix / junk) before any DB work —
    // a cheap filter at the enrollment surface (the auth boundary is the gate below).
    if (!isDeviceTokenShape(deviceToken)) {
      return { status: 401, body: { error: "invalid device token" } };
    }
    const machineId = machineIdFromToken(deviceToken);
    let machine = await store.getMachine(machineId);
    if (machine) {
      // Already enrolled: the derived machine id matched. Verify the FULL token hash
      // too — defense against a 64-bit machine-id truncation collision handing one
      // machine's authority to a different token (audit H-01 criterion (a)).
      if (machine.tokenHash && machine.tokenHash !== sha256(deviceToken)) {
        return { status: 401, body: { error: "device token mismatch" } };
      }
    } else {
      // First contact — self-register, but ONLY an enrollable token:
      //  - open/dev mode (gate off): any well-shaped token enrolls into the shared
      //    workspace (anonymous BYOA is intentional there);
      //  - gated mode (GitHub login on): the token MUST resolve to a live, unexpired
      //    connect key bound to a signed-in user (getDeviceOwner) — i.e. the owner
      //    ran the web/AI-First connect flow. An unknown/forged token is REJECTED,
      //    never minted into a "shared" machine (audit H-01 / M2). This closes the
      //    unauthenticated self-registration + resource-creation hole.
      const owner = await getDeviceOwner(machineId);
      if (loginGateEnabled() && owner == null) {
        return { status: 401, body: { error: "unknown device token — connect this machine first" } };
      }
      const ownerId = owner ?? "shared";
      // Home/default team for this machine: ALWAYS the owner's personal team (the
      // no-claim fallback for loops created on it later). A loop's actual team comes
      // from the validated claim intent at createLoop time, never from this home
      // team — so cross-team capture still lands in team B. Keeping home = personal
      // team preserves the safe invariant that a machine's fallback can never be a
      // shared team the owner is merely a (possibly later-revoked) member of.
      const teamId = store.teamIdForUser(ownerId);
      await store.ensureTeam(teamId, ownerId === "shared" ? "Shared Workspace" : "Personal Team", ownerId === "shared" ? null : ownerId);
      machine = await store.createMachine({
        id: machineId,
        userId: ownerId,
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
    // Stamp online + lastSeen — THROTTLED: only when the flag must flip or the
    // stamp is older than LAST_SEEN_REFRESH_MS. Only the sweep (ONLINE_TTL_MS)
    // and presence reads consume it, so the hot path stays read-only.
    if (!machine.online || !machine.lastSeen || Date.now() - Date.parse(machine.lastSeen) > LAST_SEEN_REFRESH_MS) {
      await store.setMachineOnline(machineId, true);
    }
    // Identity rarely changes after the first poll — only write it when a field
    // actually differs, so the hot path (every ~3s/machine) isn't a 2nd UPDATE.
    if (info) {
      // Untrusted wire input: a version is a short semver, so clip defensively.
      const version = typeof info.version === "string" ? clipText(info.version, 64) : undefined;
      const patch = {
        ...(info.host && info.host !== machine.hostname ? { hostname: info.host } : {}),
        ...(info.platform && info.platform !== machine.platform ? { platform: info.platform } : {}),
        ...(info.arch && info.arch !== machine.arch ? { arch: info.arch } : {}),
        ...(version && version !== machine.daemonVersion ? { daemonVersion: version } : {}),
        ...(info.host && !machine.name?.trim() ? { name: info.host } : {}),
      };
      if (Object.keys(patch).length) await store.updateMachine(machineId, patch);
    }

    // Live progress for in-flight runs (slim activity line, not the transcript).
    // Scope to this machine's own running rows; a finalized row is left alone.
    // Untrusted wire input: one entry per in-flight run is the legitimate shape,
    // so anything past the cap is garbage — process at most MAX_PROGRESS_ENTRIES.
    if (progress?.length) {
      for (const p of progress.slice(0, MAX_PROGRESS_ENTRIES)) {
        if (typeof p?.runId !== "string" || typeof p.label !== "string") continue;
        const run = await store.getRun(p.runId);
        if (run?.machineId !== machineId || run.phase !== "running") continue;
        const step = Number(p.step) || 0;
        const label = clipText(p.label, 200);
        // Skip the write when the signal hasn't moved — claude can sit inside one
        // long tool_use across several 3s heartbeats, so most polls repeat it. The
        // freshness stamp (`at`, the sweep's inactivity signal) still refreshes,
        // throttled to once a minute so the hot path isn't a per-poll UPDATE.
        const cur = run.progress;
        const moved = cur?.step !== step || cur?.label !== label;
        const stampStale = !cur?.at || Date.now() - Date.parse(cur.at) > PROGRESS_STAMP_REFRESH_MS;
        if (moved || stampStale) {
          await store.updateRun(p.runId, { progress: { step, label, at: nowIso() } });
        }
      }
    }

    const deliveries: Delivery[] = [];
    for (const run of await store.pendingRunsForMachine(machineId)) {
      const loop = await store.getLoop(run.loopId);
      if (!loop) {
        await store.updateRun(run.id, { phase: "error", outcome: "error", error: "loop removed", ts: nowIso() });
        continue;
      }
      // ATOMIC claim (pending -> running, conditional on the phase): with an async
      // session, two concurrent polls (an HTTP retry racing its timed-out original,
      // or two daemons sharing one device token = the same machineId) could both
      // read this run as pending and both deliver it - double execution. Under
      // sync SQLite the whole handler was atomic, so the plain read-then-write was
      // safe; now only the winner of the conditional UPDATE mints the lease and
      // ships the delivery, and the loser skips.
      if (!(await store.claimPendingRun(run.id))) continue;
      // Edit + evolve runs exist to change the loop, so they always get control
      // AND the structural edit caps (schedule, UI, schema, workflow).
      const structural = run.role === "evolve" || run.role === "edit";
      const token = await registerRunLease({
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
      deliveries.push(await buildDelivery(loop, run.id, token, machine.roots ?? []));
    }

    // Watch set: every loop bound to this machine (not just those with a pending
    // run) so the daemon watches each loop's folder continuously — between runs
    // and across restarts (the set stays server-authoritative). Served from a
    // short-TTL cache; any delivery recomputes (the run may belong to a brand-new
    // loop whose folder must be watched before it writes). The daemon resolves
    // the actual folder per loop (dirname(taskFile) → workdir).
    let cached = this.watchCache.get(machineId);
    if (!cached || deliveries.length || Date.now() - cached.at > WATCH_CACHE_TTL_MS) {
      const watch: WatchEntry[] = (await store.loopsForMachine(machineId))
        .map((l) => ({
          loopId: l.id,
          workdir: l.workdir ?? null,
          taskFile: l.taskFile ?? null,
        }))
        .sort((a, b) => (a.loopId < b.loopId ? -1 : a.loopId > b.loopId ? 1 : 0));
      cached = { at: Date.now(), digest: sha256(JSON.stringify(watch)), watch };
      this.watchCache.set(machineId, cached);
    }

    if (deliveries.length) log.info({ machineId, exec: deliveries.length }, "poll: delivered");
    // A matching digest echo means the daemon already holds this exact watch set —
    // omit the array. An old daemon never echoes, so it always gets the full list
    // (omission requires proof the client speaks the digest protocol, never a default).
    return {
      status: 200,
      body: {
        deliveries,
        watchDigest: cached.digest,
        ...(watchDigest === cached.digest ? {} : { watch: cached.watch }),
      },
    };
  }

  /**
   * Long-poll wrapper over `poll()`: when the daemon opted in (`wait:true`) and
   * the immediate pass claimed nothing, park the request on the machine's waiter
   * until the Dispatcher wakes it (a run went pending) or the bounded window
   * elapses, then re-claim. Old daemons never send `wait` and keep the classic
   * instant response. The waiter is armed BEFORE the first claim pass, so a run
   * that goes pending while the pass is in flight can never slip past the park.
   */
  async pollWait(
    deviceToken: string,
    info?: { host?: string; platform?: string; arch?: string; version?: string },
    progress?: Array<{ runId: string; step: number; label: string }>,
    opts?: { wait?: boolean; watchDigest?: string; waitMs?: number },
  ): Promise<HttpResult> {
    if (!opts?.wait) return this.poll(deviceToken, info, progress, opts?.watchDigest);
    const machineId = machineIdFromToken(deviceToken);
    const waitMs = Math.min(Math.max(opts.waitMs ?? LONG_POLL_WAIT_MS, 0), LONG_POLL_WAIT_MS);
    const waiter = this.armPollWaiter(machineId, waitMs);
    try {
      const first = await this.poll(deviceToken, info, progress, opts.watchDigest);
      if (first.status !== 200) return first;
      if ((first.body as { deliveries: Delivery[] }).deliveries.length) return first;
      const woken = await waiter.promise;
      if (!woken) {
        // Timed out empty: re-stamp before returning so the ~20s hold never eats
        // into the 30s ONLINE_TTL budget (the first pass's stamp is now that old).
        await store.setMachineOnline(machineId, true);
        return first;
      }
      // Woken: re-run the claim pass (identity/progress were already applied).
      return await this.poll(deviceToken, undefined, undefined, opts.watchDigest);
    } finally {
      waiter.cancel();
    }
  }

  // ---- GET /api/machine/status ----

  /**
   * Whether this machine (by device token) currently has a live daemon — so
   * Claude Code can avoid starting a duplicate. `online` is fresh-checked against
   * the poll TTL, not just the stored flag.
   */
  async status(deviceToken: string): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const machine = await store.getMachine(machineId);
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
  async createLoop(
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
      /** Coding agent this loop is bound to and EXECUTED with (claude-code | codex |
       *  grok). Absent for older daemons → defaults to claude-code. The daemon
       *  spawns that agent on the bound machine. */
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
  ): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const machine = await store.getMachine(machineId);
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
    const wf = validateWorkflow(str(body.workflow)?.slice(0, WIRE_TEXT_CAP) ?? "");
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
    const agent: CodingAgent =
      body.agent === "codex" || body.agent === "grok" ? body.agent : "claude-code";

    const stateSchema = store.coerceStateSchema(body.stateSchema) ?? null;
    // Optional day-one dashboard — same validate/clip surface as `set-ui` (editLoop).
    // Sanitized to the allowed tags/attrs; an unusable value coerces to null.
    const ui = validateUi(str(body.ui)?.slice(0, WIRE_TEXT_CAP) ?? "").value;
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
      const existing = existingId ? await store.getLoop(existingId) : undefined;
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
    const intent = await readClaimIntent(str(body.claim));
    if (intent && intent.teamId !== homeTeam) {
      // CROSS-TEAM create. SECURITY (report §4) — fail CLOSED, never silently
      // mis-file into the home team (the original bug):
      //  - bind the claim to its minter: the same human who minted it under a
      //    validated team session must be the one creating the loop;
      //  - RE-VALIDATE authorization NOW (membership can change after mint),
      //    mirroring requestScope: a current team member. The team value itself
      //    is server-minted, never client input.
      if (machine.userId !== intent.userId) {
        return { status: 403, body: { error: "connect-key was minted by a different user" } };
      }
      const authorized = await store.isTeamMember(intent.teamId, machine.userId);
      if (!authorized) {
        return { status: 403, body: { error: "not authorized to create loops in that team" } };
      }
      teamId = intent.teamId;
    }
    // Default to the team's most recently configured channel (listChannels is
    // newest-first) so a freshly-added Feishu/Telegram channel auto-applies to new
    // loops — computed against the RESOLVED team so it routes to that team's channel.
    const channelId = await store.defaultChannelId(teamId);
    const loop = await store.createLoop({
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
    this.invalidateWatch(machineId); // a new loop folder must be watched promptly
    // Run once immediately so a freshly-created loop produces output without
    // waiting for its first cron tick (gated on `enabled`).
    if (loop.enabled) await this.scheduler.runNow(loop.id);
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
   *  from the optional set, and an unknown field fails loud (P6, VALIDATION_ERROR).
   *  `--json` (OQ4) is the escape hatch: the full structured records as real JSON
   *  (first byte `[`), mirroring `show --json` — the daemon prints `text` either way. */
  async listLoops(deviceToken: string, fieldsFlag?: string, json?: boolean): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };

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
    // The derived cells cost an extra query per loop; the TOON path pays for them only
    // when the column is actually selected (the default `loopany loops` computes
    // neither). The `--json` escape hatch mirrors `show --json`, which ALWAYS computes
    // both, so force them on for JSON — a plain `loopany loops --json` must report the
    // real `runs`/`lastOutcome` per loop, never a lazy 0/null.
    const wantRuns = json || fields.includes("runs");
    const wantLastOutcome = json || fields.includes("lastOutcome");

    const loops: LoopListRecord[] = await Promise.all(
      (await store.loopsForMachine(machineId)).map(async (l) => {
        // Derived cadence fire (P4): the NEXT time the cron fires in the loop's tz. A
        // paused loop shows no next fire (— in the cell), matching §4.2.
        const nextFire = l.enabled ? (nextFires(l.cron, l.timezone, 1)[0] ?? null) : null;
        // The last-outcome cell tracks the newest EXEC (scheduled) run, aligning with
        // `show` — a later successful evolve/edit must never mask a failed scheduled run.
        const last = wantLastOutcome ? await store.lastExecRun(l.id) : undefined;
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
          runs: wantRuns ? await store.countRuns(l.id) : 0,
          lastOutcome: last ? runOutcomeToken(last) : null,
        };
      }),
    );
    // `--json` escape hatch: emit the full records as real JSON in `text` (the daemon
    // prints it verbatim), the exact counterpart to `show --json`. TOON is the default.
    const text = json ? JSON.stringify(loops, null, 2) : renderLoopsText(loops, fields);
    // `loops` is a RETAINED data channel (`CLI_RETAINED_KEYS`): the daemon resolves
    // cwd→loop CLIENT-side (`log`/`show`/`home`) from these rows. `ok` is render-only and
    // stripped at the cli boundary; the legacy `/api/machine/loop` GET route keeps it.
    return { status: 200, body: { ok: true, loops, text } };
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
  async loopLog(deviceToken: string, loopId: unknown, limit?: unknown): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    return this.renderLoopLog(machineId, loopId, limit);
  }

  /** The machine-scoped run survey, shared by the device-token `loopLog` (resolves
   *  the machine from the token) AND the unified-dispatch run-credential `log` branch
   *  in `CliGateway` (passes the run lease's own machineId + loopId — this is what
   *  closes the in-run `loopany log` 400 seam); public for that second consumer.
   *  Scoping is identical for both callers: only a loop
   *  bound to `machineId` is visible; anything else is a flat 404 (existence never
   *  leaks), exactly as before for the device path. */
  async renderLoopLog(machineId: string, loopId: unknown, limit?: unknown): Promise<HttpResult> {
    if (typeof loopId !== "string" || !loopId) return { status: 400, body: { error: "loopId required" } };
    const loop = await store.getLoop(loopId);
    // Loop+device scoping: only a loop bound to this machine is visible. A token
    // for device A, or for a different loop, gets a flat 404 (existence never leaks).
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    const want = Number(limit);
    const n = Math.min(Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : LOG_RUNS_DEFAULT, 1), LOG_RUNS_MAX);
    // listRuns returns the newest n runs oldest-first; reverse to newest-first so
    // the agent reads the most recent history at the top.
    const rows = (await store.listRuns(loopId, n)).slice().reverse();
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
    // The TOON survey is the default render (`text`, prints in-run — the F2 fix); the
    // structured `runs` rides ALONGSIDE it as a RETAINED data channel (`CLI_RETAINED_KEYS`)
    // — the `log --json` escape hatch and the `log --transcript` inline render read it,
    // since the survey `text` stays concise. `ok`/`loopId`/`name` are render-only and
    // stripped at the cli boundary; the LEGACY `/api/machine/log` route (not finalized)
    // still carries them for a pre-0.12 daemon on the postCli 404-fallback.
    const survey = renderLogText(loop.name ?? loop.id, loop.id, runs, await store.countRuns(loopId));
    return { status: 200, body: { ok: true, loopId: loop.id, name: loop.name ?? loop.id, runs, text: survey } };
  }

  /**
   * Edit a loop's scheduling envelope from the owner's interactive agent
   * (`loopany edit`). Authed by the machine's device token and scoped to loops
   * bound to THAT machine — deliberately NOT gated by allowControl (that flag
   * governs a running run rescheduling ITSELF; the human owner may always edit).
   * Task CONTENT lives in the loop's README.md on the machine, so it's edited there, not here.
   */
  async editLoop(
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
      agent?: unknown;
    },
    /** Validate-only (`loopany edit --dry-run`): compute the per-key before→after
     *  preview + rejections, persist NOTHING. */
    dryRun = false,
  ): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (typeof id !== "string" || !id) return { status: 400, body: { error: "loop id required" } };
    const loop = await store.getLoop(id);
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

    const { update, changes, rejections } = await this.buildEditUpdate(loop, p);

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

    const updated = await store.updateLoop(id, update);
    if (!updated) return { status: 404, body: { error: "loop not found" } };
    // Re-arm the scheduler: an enabled flip toggles add/remove, any other change re-adds.
    if (updated.enabled) this.scheduler.addLoop(updated);
    else this.scheduler.removeLoop(updated.id);
    this.invalidateWatch(machineId); // taskFile may have moved the watched folder
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
  private async buildEditUpdate(
    loop: Loop,
    p: Record<string, unknown>,
  ): Promise<{ update: Partial<NewLoop>; changes: Array<{ key: string; from: unknown; to: unknown }>; rejections: Array<{ key: string; reason: string }> }> {
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
    // Coding agent: only a known `CodingAgent` (the shared enum validator, so this
    // widens automatically as the enum grows). The next run spawns the new agent,
    // matching how model/cron edits behave.
    if (p.agent !== undefined) {
      const a = coerceCodingAgent(p.agent);
      if (!a) rejections.push({ key: "agent", reason: `agent must be one of ${CODING_AGENTS.join(", ")}` });
      else set("agent", a, loop.agent);
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
        const v = validateWorkflow(clipText(p.workflow, WIRE_TEXT_CAP));
        if (!v.ok) rejections.push({ key: "workflow", reason: v.detail });
        else set("workflow", v.value, loop.workflow);
      }
    }
    if (p.ui !== undefined) {
      if (p.ui === null) set("ui", null, loop.ui);
      else if (typeof p.ui !== "string") rejections.push({ key: "ui", reason: "ui must be a string (the dashboard HTML)" });
      else set("ui", validateUi(clipText(p.ui, WIRE_TEXT_CAP)).value, loop.ui);
    }
    if (p.stateSchema !== undefined) {
      if (p.stateSchema === null) set("stateSchema", null, loop.stateSchema);
      else {
        const v = await validateSchema(loop.id, p.stateSchema);
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

  // ---- POST /machine/report ----

  async report(
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
      /** Content status — same vocabulary as an agent's `loopany report --status`
       *  (new | resolved | nothing-new). An agent sets this via that CLI verb
       *  mid-run instead; this lets a pure zero-LLM workflow set it too, since
       *  only it calls this final report directly. Untrusted wire input —
       *  anything outside the enum is dropped (never persisted). */
      status?: unknown;
      /** Workflow cursor (free-form) → persisted as loop.state for next run's `prev`. */
      cursor?: unknown;
      /** Claude-reported cost/usage for this run (usd + token counts). */
      cost?: unknown;
      /** Total claude invocations (present only when the daemon's transient-
       *  failure recovery resumed the session at least once). */
      attempts?: unknown;
    },
  ): Promise<HttpResult> {
    const lease = await resolveLease(runToken);
    if (!lease) return { status: 401, body: { error: "invalid or expired token" } };
    const ok = !!body.ok;

    const run = await store.getRun(lease.runId);
    // The user stopped this run while the machine was still working — keep it
    // canceled, and bail BEFORE any loop-level write: a late report must not
    // advance the workflow cursor / task file (the next run would silently skip
    // data whose output the user never saw), nor flip the phase to done/error.
    if (run?.phase === "canceled") {
      await retireLease(runToken);
      // Clear a pending edit even if its run was canceled, so it doesn't re-fire —
      // and symmetrically clear an evolve marker (evolveDue), or the canceled
      // evolve pass re-fires on the very next tick.
      if (lease.role === "edit") await this.scheduler.finishEdit(lease.loopId);
      if (lease.role === "evolve") await this.scheduler.finishEvolution(lease.loopId);
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
      await store.updateRun(lease.runId, {
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: clipText(body.sessionId, SESSION_ID_CAP) } : {}),
        ...(enrichArtifacts ? { artifacts: enrichArtifacts } : {}),
        ...(enrichTranscript ? { transcript: enrichTranscript } : {}),
        // Cost, like durationMs, is only known post-run — enrich the finished row.
        ...coerceCost({ ...(typeof body.cost === "object" && body.cost ? body.cost : {}), attempts: body.attempts }),
      });
      if (typeof body.taskFileContent === "string") {
        await store.updateLoop(lease.loopId, {
          taskFileContent: clipText(body.taskFileContent, WIRE_TEXT_CAP),
          taskFileSyncedAt: nowIso(),
        });
      }
      await retireLease(runToken);
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
      const message = typeof rawMessage === "string" ? clipText(rawMessage, MESSAGE_CAP) : undefined;
      const claimedOutcome = RUN_OUTCOMES.has(body.outcome as string) ? body.outcome : undefined;
      const claimedStatus = RUN_STATUSES.has(body.status as string)
        ? (body.status as "new" | "resolved" | "nothing-new")
        : undefined;
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
        } else {
          // Postgres jsonb rejects NUL — strip it from the free-form cursor's strings.
          cursor = stripNulDeep(cursor);
        }
      }
      if (typeof body.taskFileContent === "string") {
        await store.updateLoop(lease.loopId, {
          taskFileContent: clipText(body.taskFileContent, WIRE_TEXT_CAP),
          taskFileSyncedAt: nowIso(),
        });
      }
      if (cursor !== undefined) await store.updateLoop(lease.loopId, { state: cursor });
      // Mirror the workflow's scalar cursor onto THIS run for {{latest.*}} / the
      // trend chart — don't clobber a state the run already reported.
      const runState = ok && !run.state ? scalarState(cursor) : undefined;
      const finalized = await store.updateRun(lease.runId, {
        phase: ok ? "done" : "error",
        outcome: ok ? claimedOutcome ?? (lease.role === "evolve" ? "evolve" : "exec") : "error",
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: clipText(body.sessionId, SESSION_ID_CAP) } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(transcript ? { transcript } : {}),
        ...(runState ? { state: runState } : {}),
        ...(claimedStatus ? { status: claimedStatus } : {}),
        ...(message !== undefined ? { message } : {}),
        // Success clears the generic reclaim reason; a genuine late failure REPLACES
        // it with the real error (honest record), keeping the run an error.
        ...(ok
          ? { error: null }
          : { error: typeof body.error === "string" ? clipText(body.error, MESSAGE_CAP) : run.error }),
        progress: null,
        ts: nowIso(),
      });
      // Single-shot: no second late report may re-flip this run.
      await retireLease(runToken);
      // Re-capture the end-state snapshot (best-effort), same as the normal path.
      try {
        await store.putRunSnapshot(lease.runId, lease.loopId, await store.buildLoopManifest(lease.loopId));
        await store.pruneRunSnapshots(lease.loopId, snapshotRetention());
      } catch (err) {
        log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
      }
      if (ok && lease.role !== "evolve" && lease.role !== "edit") {
        // The failure alert was WRONG — the run actually succeeded. Flipping the row
        // to `done` already corrects the failure streak (it's derived from persisted
        // rows), so a later tick won't count this. Retract by pushing the real result
        // (a cheap, honest correction), gated by the loop's normal notify policy.
        const loop = await store.getLoop(lease.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          this.pushNotify(loop, finalized.message);
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
      } else {
        // Postgres jsonb rejects NUL — strip it from the free-form cursor's strings.
        cursor = stripNulDeep(cursor);
      }
    }
    if (cursor !== undefined) await store.updateLoop(lease.loopId, { state: cursor });

    // Sync the machine's task file onto the loop (untrusted wire input — clip
    // defensively even though the daemon already caps it).
    if (typeof body.taskFileContent === "string") {
      await store.updateLoop(lease.loopId, {
        taskFileContent: clipText(body.taskFileContent, WIRE_TEXT_CAP),
        taskFileSyncedAt: nowIso(),
      });
    }

    // Message: a workflow reports it here; a claude run already set it via the
    // agent-api `loopany report` — fall back to claude's final text only if blank.
    // Clipped to the same cap the agent-api report verb enforces.
    const rawMessage =
      body.message !== undefined ? body.message : !run?.message && body.finalText ? body.finalText : undefined;
    const message = typeof rawMessage === "string" ? clipText(rawMessage, MESSAGE_CAP) : rawMessage;

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
    const claimedStatus = RUN_STATUSES.has(body.status as string)
      ? (body.status as "new" | "resolved" | "nothing-new")
      : undefined;
    const finalized = await store.updateRun(lease.runId, {
      phase: ok ? "done" : "error",
      outcome: ok ? claimedOutcome ?? (lease.role === "evolve" ? "evolve" : "exec") : "error",
      durationMs: body.durationMs ?? null,
      // Untrusted wire input — clip like every other free-text field.
      sessionId: typeof body.sessionId === "string" ? clipText(body.sessionId, SESSION_ID_CAP) : null,
      ...(artifacts ? { artifacts } : {}),
      ...(transcript ? { transcript } : {}),
      ...coerceCost({ ...(typeof body.cost === "object" && body.cost ? body.cost : {}), attempts: body.attempts }),
      ...(runState ? { state: runState } : {}),
      ...(claimedStatus ? { status: claimedStatus } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(ok ? {} : { error: typeof body.error === "string" ? clipText(body.error, MESSAGE_CAP) : "run failed on machine" }),
      progress: null, // live signal done — the full transcript supersedes it
      ts: nowIso(),
    });
    await retireLease(runToken);

    // Capture the loop's full file set as THIS run's snapshot (Phase 3 diff
    // baseline). Cheap: just record the manifest from the already-synced
    // artifact_files; the diff is computed lazily on read (getRunDiff), never
    // here. The daemon flushes a final run-tagged sync before reporting, so this
    // reflects the run's end-state. Best-effort — never let it fail the report.
    try {
      await store.putRunSnapshot(lease.runId, lease.loopId, await store.buildLoopManifest(lease.loopId));
      // Bound the snapshot history right away (cheap, keeps the table from growing
      // unbounded between maintenance passes). The blobs this unpins are reclaimed
      // by the periodic GC, not here — the grace window means a just-unreferenced
      // blob isn't collectable yet anyway, and report() must stay lean + zero-exec.
      await store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
    }

    if (lease.role === "evolve") {
      await this.scheduler.finishEvolution(lease.loopId);
    } else if (lease.role === "edit") {
      // Always clear the marker (done OR error) so a stuck edit can't hijack
      // every subsequent tick. The owner re-issues if it didn't take.
      await this.scheduler.finishEdit(lease.loopId);
    } else if (ok) {
      await this.scheduler.maybeFlagEvolve(lease.loopId);
    }

    // Notify (the loop's chosen channel), best-effort. Edit/evolve runs are
    // internal (owner config change / self-shaping) — never user-facing, success
    // OR failure. `updateRun` already returned the finalized row.
    if (lease.role !== "evolve" && lease.role !== "edit") {
      if (ok) {
        // Success: gate on the loop's notify policy + the run's content status.
        const loop = await store.getLoop(lease.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          this.pushNotify(loop, finalized.message);
        }
      } else {
        // Failure: surface it (silent failure is the BYOA default failure mode),
        // anti-spam'd by the consecutive-failure streak so a persistently-broken
        // loop doesn't push every tick.
        await this.notifyRunFailure(lease.loopId, lease.role, finalized?.error ?? null);
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
   *
   * Public (not private): `CliGateway`'s `finish`/`complete` dispatch case is the
   * second consumer - the verb routing moved to `gateway/cli.ts`, the core
   * loop-lifecycle write stays here.
   */
  async finishLoop(
    lease: RunLease,
    { message, reason, state }: { message?: string; reason: string | null; state?: Record<string, number | string> },
  ): Promise<Applied> {
    // TOCTOU: refuse if the loop is no longer closed (goal cleared since poll).
    const current = await store.getLoop(lease.loopId);
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
    const run = await store.getRun(lease.runId);
    const durationMs = run ? Date.now() - Date.parse(run.ts) : NaN;
    await store.updateRun(lease.runId, {
      phase: "done",
      outcome: "exec",
      status: "resolved",
      ...(message !== undefined ? { message } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
      progress: null,
      ts,
    });
    const loop = await store.updateLoop(lease.loopId, { completedAt: ts, completionReason: reason, enabled: false });
    this.scheduler.removeLoop(lease.loopId);
    // Snapshot the loop's end-state (Phase 3 diff baseline), best-effort like report().
    try {
      await store.putRunSnapshot(lease.runId, lease.loopId, await store.buildLoopManifest(lease.loopId));
      await store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "finish: snapshot capture failed");
    }
    // Completion is a distinct terminal event — notify unless the user opted out
    // of all pushes (notify: "never"). Best-effort (void), like the report path.
    if (loop && loop.notify !== "never") {
      this.pushNotify(loop, completionMessage(reason, message));
    }
    log.info({ runId: lease.runId, loopId: lease.loopId }, "finish: loop completed");
    return { ok: true, detail: "loop finished — goal met, loop completed" };
  }
}

// ---- helpers (ported from control.ts) ----

/** The `{ ok, detail }` result shape shared by `finishLoop`/`validCadence` here and
 *  the `applyMutation`/`applySet*` verb bodies in `cli.ts`. */
export interface Applied {
  ok: boolean;
  detail?: string;
  /** An explicit axi error slug for a rejection (else the caller derives it from the
   *  HTTP status). Used to mark a second-`finish` as CONFLICT rather than a generic
   *  VALIDATION_ERROR. */
  code?: string;
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
// Each builds the `text` a CLI verb carries; the CLI-only renders live with their
// verbs in `cli.ts` (whose `finalizeCli` strips the superset fields at the
// `/api/machine/cli` boundary - the legacy endpoints keep them). Pure — no I/O,
// no clock — so they're exercised both here (via the verb tests) and directly in
// `toon.test.ts`. The time formatters + outcome/metric tokens are exported for
// `cli.ts` so both files render cells identically.

/** Compact a stored ISO timestamp to `YYYY-MM-DD HH:MM` (UTC, as stored) for a TOON
 *  cell — a date the agent reads at a glance without the `T`/seconds/zone noise. */
export function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** Format an instant in a loop's OWN timezone with a short zone name
 *  (`2026-07-08 05:00 GMT+8`), so cadence previews read in the schedule the owner set
 *  rather than raw UTC (F9). `seconds` adds `:SS` for the single `show` nextFire; the
 *  multi-item `nextRuns` list stays minute-granular. Falls back to the bare `fmtTime`
 *  slice if the tz is invalid/absent. */
export function fmtTimeZoned(iso: string, timezone: string | null, opts: { seconds?: boolean } = {}): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(opts.seconds ? { second: "2-digit" } : {}),
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const sec = opts.seconds ? `:${get("second")}` : "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${sec} ${get("timeZoneName")}`;
  } catch {
    return fmtTime(iso);
  }
}

/** `loopany loops` default columns (P2 — minimal): identity + the two things an
 *  agent scans for (schedule + when it next fires). */
const LIST_DEFAULT_FIELDS: string[] = ["id", "name", "cron", "enabled", "nextFire"];
/** The optional columns `--fields` may add (the "available" set an unknown field is
 *  measured against, §4.2). `runs`/`lastOutcome` are derived per loop. */
const LIST_OPTIONAL_FIELDS: string[] = ["timezone", "notify", "model", "goal", "taskFile", "runs", "lastOutcome"];

/** A loop's row for `loopany loops`: every renderable cell precomputed once (so the
 *  `--fields` selection is a pure column pick). The structured `loops` body carries the
 *  whole record — a RETAINED data channel the daemon reads to resolve cwd→loop
 *  client-side (id/name/workdir/taskFile), not for rendering. */
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
export function runOutcomeToken(r: { phase: string; outcome: string | null; status: string | null }): string {
  if (r.outcome === "evolve") return "evolve";
  if (r.outcome === "skipped") return "skipped";
  const base = r.phase === "error" ? "failed" : r.phase === "done" ? "ok" : r.phase;
  return r.status ? `${base}/${r.status}` : base;
}

/** A run's reported metrics as `k=v,k=v` (or null → the em-dash), for the log cell. */
export function runMetricsToken(state: Record<string, unknown> | null | undefined): string | null {
  if (!state || typeof state !== "object") return null;
  const parts = Object.entries(state).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(",") : null;
}

/** How many chars of a run message the log cell inlines before the size hint. */
export const LOG_MESSAGE_CELL_CAP = 100;

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
  // Render the fire preview in the loop's OWN tz with a zone label (F9), matching
  // `show`'s `nextFire` — not raw, unlabeled UTC.
  const nextRuns = nextFires(cron, timezone, 3).map((iso) => fmtTimeZoned(iso, timezone));
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
    nextRuns.length ? inlineArray("nextRuns", nextRuns.map((iso) => fmtTimeZoned(iso, config.timezone)), " · ") : null,
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

/** Recursively strip NUL from a free-form JSON value's string keys + values — for the
 *  workflow cursor, which is stored whole into the `loop.state` jsonb column (same
 *  Postgres U+0000 constraint). Structure-preserving; non-strings pass through. */
function stripNulDeep(v: unknown): unknown {
  if (typeof v === "string") return stripNul(v);
  if (Array.isArray(v)) return v.map(stripNulDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[stripNul(k)] = stripNulDeep(val);
    return out;
  }
  return v;
}

/** Trim a value to a non-empty string, or null (NUL stripped). Shared by
 *  createLoop/editLoop. */
function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = stripNul(v).trim();
  return t ? t : null;
}

/** Structural equality for an editLoop before→after comparison: null and undefined
 *  are equal (an absent field re-fed as null is unchanged); objects/arrays compare by
 *  their CANONICAL JSON serialization (stateSchema is a small array; object keys are
 *  sorted so the comparison is order-INSENSITIVE — a value re-read from a pg `jsonb`
 *  column comes back with its keys normalized, which must not read as a change against
 *  a freshly-coerced value); everything else by `===`. Powers the no-op filter that
 *  makes the `show --json` → `edit` roundtrip a no-op. */
function sameLoopValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return canonicalJson(a) === canonicalJson(b);
  return false;
}

/** Stable JSON with recursively sorted object keys — so two structurally-equal values
 *  serialize identically regardless of key ordering (pg `jsonb` normalizes key order). */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : val,
  );
}

/** Bound a value for the dry-run before→after preview: a long content string
 *  (workflow JS / dashboard HTML) is clipped so the response stays small; other
 *  scalars/arrays pass through as-is (they're already small). */
function clipPreview(v: unknown): unknown {
  const CAP = 200;
  if (typeof v === "string" && v.length > CAP) return v.slice(0, CAP) + `… (+${v.length - CAP} chars)`;
  return v;
}

/** Exported for `cli.ts` (`set-tz`), so every write path shares one tz check. */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The one user-facing message for a rejected timezone, shared by every write path. */
export function invalidTimezoneError(tz: string): string {
  return `invalid timezone: ${tz} (use an IANA name e.g. "Asia/Shanghai")`;
}

/** Probe the cadence IN the loop's timezone (fire times shift with it) — the tz,
 *  when given, must already be validated (validTimezone) so a croner throw here
 *  always means a bad expression, not a bad zone. Exported for `cli.ts` (`set-cron`). */
export function validCadence(cron: string, timezone?: string | null): Applied {
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
