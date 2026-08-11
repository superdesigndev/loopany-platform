/**
 * KERNEL SWEEP - the server-side time driver (P0 stage B; design doc §3 option
 * C). The kernel itself owns no clock: every trigger's `nextFireAt` is DATA, so
 * server-side time is one indexed question - "which teams have a due, enabled
 * trigger?" - answered every ~30s, followed by the same authority tick the
 * remote `loopany-kernel tick` runs. Option B (a single armed timer at
 * min(nextFireAt)) is a later latency optimization; the sweep stays as its
 * safety net either way.
 *
 * After a tick mints pending runs, the sweep resolves each run's assignee
 * machine segment (`mbp` in `mbp/claude`) to a machines row by team alias and
 * WAKES that machine's long-poll - delivery latency drops from a poll interval
 * to ~0. Resolution failures are LOGGED, never errors: the pending run is the
 * durable inbox, and an unknown alias simply waits for the machine to enroll
 * (same deferred semantics the offline-Wednesday scenario pinned).
 *
 * Overlap guard: an in-flight latch skips a sweep round while the previous one
 * still runs (a slow DB must not stack rounds). The kernel's run-id hash dedup
 * (id = hash(cause, task, scheduledAt)) is the second net - even a double tick
 * cannot mint the same fire twice.
 */
import { isDispatchable } from "@loopany/kernel";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { kernelTriggers } from "../db/schema.js";
import * as store from "../db/store.js";
import { logger } from "../logger.js";
import { recordDispatchBlocked } from "./blocked.js";
import { tickTeamAtAuthority } from "./gateway.js";
import { sweepOfflineKernelRuns } from "./recover.js";

/** Sweep cadence (ms). 0 disables the sweep entirely (tests / tools). */
export function kernelSweepIntervalMs(): number {
  const raw = process.env.LOOPANY_KERNEL_SWEEP_MS;
  if (raw === undefined || raw === "") {
    // Under vitest the sweep stays OFF unless a test opts in explicitly - a
    // real-clock interval inside a booted test server would tick nondeterministically
    // (the same convention as the rate limiter's VITEST guard).
    if (process.env.VITEST || process.env.NODE_ENV === "test") return 0;
    return 30_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/** Teams with at least one enabled, due kernel trigger - the ONE indexed
 *  question that scales with due work, not with total loop count. */
export async function dueKernelTeams(now: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ teamId: kernelTriggers.teamId })
    .from(kernelTriggers)
    .where(sql`${kernelTriggers.enabled} = true and ${kernelTriggers.nextFireAt} <= ${now}`);
  return rows.map((r) => r.teamId);
}

/** Split a kernel assignee into its machine/agent segments. A bare name (no
 *  slash: local-mode style, or a person's email) has no machine segment. */
export function assigneeSegments(assignee: string | null): { machine: string; agent: string } | null {
  if (!isDispatchable(assignee)) return null;
  const i = (assignee as string).indexOf("/");
  if (i <= 0 || i === (assignee as string).length - 1) return null;
  return { machine: (assignee as string).slice(0, i), agent: (assignee as string).slice(i + 1) };
}

let inFlight = false;

/** Per-pass team cap: a pathological backlog (thousands of due teams after a
 *  long outage) must not monopolize the server in one pass — the remainder is
 *  simply still due and the next round (30s) picks it up. */
export function kernelSweepMaxTeams(): number {
  const n = Number(process.env.LOOPANY_KERNEL_SWEEP_MAX_TEAMS);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/** One sweep round: tick every due team at the authority, then wake the machines
 *  the minted runs address. `wake` is injected (the gateway's long-poll waker)
 *  so tests observe wakes without a gateway; `tickTeam` is a seam so tests can
 *  force one team to fail. Returns a per-round report.
 *
 *  ISOLATION: each team's tick runs inside its own try — one malformed/failing
 *  team logs loud and NEVER aborts the teams after it. BOUND: at most
 *  `kernelSweepMaxTeams()` teams per pass (`dropped` reports the remainder,
 *  which stays due and rides the next round). */
export async function kernelSweep(
  now: string,
  wake: (machineId: string) => void,
  tickTeam: typeof tickTeamAtAuthority = tickTeamAtAuthority,
): Promise<{ teams: number; minted: number; woken: number; skipped: boolean; failed: number; dropped: number }> {
  if (inFlight) return { teams: 0, minted: 0, woken: 0, skipped: true, failed: 0, dropped: 0 };
  inFlight = true;
  try {
    const due = await dueKernelTeams(now);
    const cap = kernelSweepMaxTeams();
    const teams = due.slice(0, cap);
    const dropped = due.length - teams.length;
    if (dropped > 0) {
      logger.warn({ due: due.length, cap, dropped }, "kernel sweep: pass capped - remainder stays due for the next round");
    }
    let minted = 0;
    let woken = 0;
    let failed = 0;
    for (const teamId of teams) {
      try {
        const r = await tickTeam(teamId, now);
        if (r.conflict) {
          // A CAS conflict means a concurrent write raced this fire; the next
          // round re-reads and the run-id dedup keeps the outcome single.
          logger.warn({ teamId, conflict: r.conflict }, "kernel sweep: tick conflict, will retry next round");
        }
        minted += r.minted.length;
        for (const run of r.minted) {
          const seg = assigneeSegments(run.assignee);
          if (!seg) continue; // person/bare assignee: nothing to wake
          const resolved = await store.resolveMachineByAlias(teamId, seg.machine);
          if (resolved.ambiguous) {
            logger.warn(
              { teamId, runId: run.id, assignee: run.assignee },
              "kernel sweep: AMBIGUOUS alias (two machines expose it in this team) - run stays pending; rename one via LOOPANY_MACHINE_ALIAS",
            );
            await recordDispatchBlocked(
              teamId,
              run,
              `alias "${seg.machine}" is AMBIGUOUS in this team (two machines expose it) - the run stays pending; rename one machine via LOOPANY_MACHINE_ALIAS`,
            );
            continue;
          }
          if (!resolved.machine) {
            logger.info(
              { teamId, runId: run.id, assignee: run.assignee },
              "kernel sweep: no machine for alias - run stays pending (durable inbox)",
            );
            await recordDispatchBlocked(
              teamId,
              run,
              `no machine in this team has alias "${seg.machine}" (assignee "${run.assignee}") - the run stays pending until that machine enrolls`,
            );
            continue;
          }
          wake(resolved.machine.id);
          woken++;
        }
      } catch (err) {
        // ISOLATED: one team's failure (malformed data, a thrown store error)
        // must never starve the teams after it.
        failed++;
        logger.error(
          { teamId, err: err instanceof Error ? err.message : String(err) },
          "kernel sweep: team tick failed - isolated, continuing with the remaining teams",
        );
      }
    }
    // Recovery detector 2: reclaim claimed kernel runs whose machine has been
    // silent past the offline window (bounded by active kernel leases).
    try {
      await sweepOfflineKernelRuns(Date.parse(now));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "kernel sweep: offline reclaim failed");
    }
    return { teams: teams.length, minted, woken, skipped: false, failed, dropped };
  } finally {
    inFlight = false;
  }
}
