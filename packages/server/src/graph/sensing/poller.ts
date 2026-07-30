/**
 * Graph Engineering v1 - SENSING, pipe 1: THE MIRROR POLLER.
 *
 * This is the first thing that makes the workspace update ITSELF. Everything
 * before it produced a snapshot: the seeder replayed a past, a verdict caused an
 * effect, but nothing brought new facts in. The poller closes that: every
 * pull-request mirror is re-read from GitHub on a cadence, real changes become
 * derived events, and the graph moves with nobody watching.
 *
 * ── the two kinds of sensing, and which one this is ──────────────────────────
 *
 * Design §7 splits sensing deliberately. DISCOVERY ("what's new out there?") is a
 * user-owned node in the compiled graph with an external query for its scope.
 * FRESHNESS ("did known things change?") is a system service whose scope is
 * derived MECHANICALLY from the watch list. This is freshness: its scope is "every
 * pull-request mirror this team holds" - a query over our own tables, never a
 * GitHub search - so it can never widen on its own. The one nod to discovery is
 * requirement 3: a fetched PR that references an unmirrored PR gets that mirror
 * created, because the reference is a fact we just observed.
 *
 * ── crash-safety, for free ──────────────────────────────────────────────────
 *
 * There is no cursor, no high-water mark and no "last polled" gate on which rows
 * are swept. A sweep re-reads everything and the DIFF decides what is news, so
 * killing the process mid-sweep loses nothing: the next sweep observes the same
 * facts, the already-written events collide on their derived ids, and the mirrors
 * that had not been reached yet get their first observation. That is the entire
 * recovery story, and it is a property of the dedup invariant rather than code -
 * which is why this module has no recovery path to get wrong.
 *
 * ── the clock ───────────────────────────────────────────────────────────────
 *
 * `sweepOnce` takes `now`. Only the background loop reads a clock, exactly like
 * `outbox/executor.ts` - so every probe is deterministic without fake timers.
 */
import { logger } from "../../logger.js";
import * as graph from "../../db/graphStore.js";
import { DEMO_TEAM_ID } from "../workspace/specs.js";
import { ghPrFetcher, groupByRepo, RATE_LIMIT_FLOOR, REPO_CONCURRENCY, type PrFetcher } from "./fetch-gh.js";
import { recordObservation } from "./observe.js";
import { PR_SOURCE, PR_TYPE, mirrorTitle, prExternalId, prUrl, type ObservedPr, type PrIdentity } from "./pr.js";

/** Default cadence. A PR's state is not a millisecond-latency concern, and the
 *  design names webhooks as the later low-latency ENTRY - not a faster poll. */
export const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

/** Mirrors observed per sweep. The whole set is normally far below this; the cap
 *  exists so a workspace that grew to thousands of mirrors degrades into several
 *  sweeps instead of one very long request burst. */
export const DEFAULT_SWEEP_LIMIT = 200;

/** New mirrors one sweep may create from cross-references. A bound, so a PR body
 *  that lists a release train cannot turn one observation into a hundred rows. */
export const MAX_DISCOVERED_PER_SWEEP = 20;

export interface SweepInput {
  /** ISO instant. REQUIRED - the sweep never reads a clock. */
  now: string;
  teamId?: string;
  /** The read transport. Injected by every probe; defaults to the `gh` CLI. */
  fetcher?: PrFetcher;
  limit?: number;
  /** Provenance actor for the observations. Defaults to the poller rule. */
  actorId?: string;
}

export interface SweepResult {
  /** Mirrors in scope this sweep. */
  mirrors: number;
  /** Repos the sweep batched into. */
  repos: number;
  /** Mirrors an observation actually moved. */
  changed: number;
  /** Derived event rows this sweep INSERTED (a re-poll makes this zero). */
  events: number;
  /** external-wait obligations discharged by an observation. */
  waitsClosed: number;
  /** Mirrors created from a cross-reference. */
  discovered: number;
  /** Mirrors the transport could not resolve, and why - surfaced, never dropped. */
  unresolved: { externalId: string; why: string }[];
  /** Observations the seam refused, with its typed code. */
  refusals: string[];
  /** Remaining GraphQL budget, when the transport reported one. */
  rateLimitRemaining?: number;
  /** True when the sweep stopped early to protect a shared rate-limit budget. */
  rateLimited: boolean;
}

/**
 * ONE freshness sweep.
 *
 * Scope is a query over our own tables (`listMirrors`), batched by repo, then one
 * `recordObservation` per mirror. Nothing is skipped on the grounds of having been
 * polled recently: a re-poll of an unchanged PR costs one comparison and writes
 * nothing, which is precisely what the dedup invariant buys.
 */
export async function sweepOnce(input: SweepInput): Promise<SweepResult> {
  const teamId = input.teamId ?? DEMO_TEAM_ID;
  const fetcher = input.fetcher ?? ghPrFetcher();
  const now = input.now;

  const mirrors = await graph.listMirrors(undefined, teamId, {
    externalSource: PR_SOURCE,
    type: PR_TYPE,
    limit: input.limit ?? DEFAULT_SWEEP_LIMIT,
  });
  const result: SweepResult = {
    mirrors: mirrors.length,
    repos: 0,
    changed: 0,
    events: 0,
    waitsClosed: 0,
    discovered: 0,
    unresolved: [],
    refusals: [],
    rateLimited: false,
  };
  if (!mirrors.length) return result;

  /** external id → mirror object id, so a batch response maps back to a row. */
  const byExternalId = new Map<string, string>();
  for (const m of mirrors) if (m.externalId) byExternalId.set(m.externalId, m.id);

  const batches = groupByRepo(mirrors.map((m) => m.externalId));
  result.repos = batches.size;

  /** Cross-referenced PRs seen this sweep, deduped before any write. */
  const referenced = new Map<string, PrIdentity>();

  // Repos run at a small fixed concurrency; each repo's PRs ride in one request.
  for (const group of chunks([...batches.entries()], REPO_CONCURRENCY)) {
    const fetched = await Promise.all(
      group.map(async ([repo, numbers]) => {
        try {
          return { repo, batch: await fetcher.fetch(repo, numbers) };
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          logger.warn({ repo, err: why }, "sensing: repo fetch failed");
          return { repo, batch: { observed: new Map<number, ObservedPr>(), missing: numbers.map((n) => ({ number: n, why })) } };
        }
      }),
    );

    for (const { repo, batch } of fetched) {
      if (typeof batch.rateLimitRemaining === "number") result.rateLimitRemaining = batch.rateLimitRemaining;
      for (const miss of batch.missing) {
        result.unresolved.push({ externalId: prExternalId({ repo, number: miss.number }), why: miss.why });
      }

      for (const [number, observed] of batch.observed) {
        const objectId = byExternalId.get(prExternalId({ repo, number }));
        if (!objectId) continue; // fetched but no longer mirrored - nothing to write
        const outcome = await recordObservation({
          objectId,
          observed,
          now,
          ...(input.actorId ? { actorId: input.actorId } : {}),
        });
        if (!outcome.ok) {
          result.refusals.push(`${repo}#${number}: ${outcome.code} - ${outcome.message}`);
          continue;
        }
        // `events` counts INSERTED rows, so a replayed observation reports zero
        // even though it derived the same ids.
        const inserted = outcome.replay ? 0 : outcome.events.length;
        if (inserted) result.changed++;
        result.events += inserted;
        result.waitsClosed += outcome.closed.length;
        for (const ref of observed.references ?? []) referenced.set(prExternalId(ref), ref);
      }
    }

    // A shared quota is not ours to drain on a background refresh. Stopping early
    // is safe by construction: the mirrors we did not reach keep their old facts
    // and the next sweep observes them.
    if (typeof result.rateLimitRemaining === "number" && result.rateLimitRemaining < RATE_LIMIT_FLOOR) {
      result.rateLimited = true;
      logger.warn({ remaining: result.rateLimitRemaining }, "sensing: stopping the sweep early to protect the rate limit");
      break;
    }
  }

  // ── requirement 3: a reference to a PR we do not mirror yet ────────────────
  result.discovered = await adoptReferences(teamId, [...referenced.values()], byExternalId, now);

  logger.info(
    {
      team: teamId,
      mirrors: result.mirrors,
      repos: result.repos,
      changed: result.changed,
      events: result.events,
      waitsClosed: result.waitsClosed,
      discovered: result.discovered,
      unresolved: result.unresolved.length,
    },
    "sensing: sweep complete",
  );
  return result;
}

/**
 * Get-or-create a mirror for every cross-referenced PR we do not hold yet.
 *
 * Straight onto the EXISTING upsert path (`graphStore.getOrCreateMirror`), which
 * is an upsert on the deterministic mirror id and never a read-then-write - so N
 * concurrent sweeps discovering the same PR converge on ONE row (design §7's
 * day-one invariant, probed directly in `graphInvariants`).
 *
 * The new mirror lands at status `observed` with NO observed facts: we learned it
 * exists, we did not read its state. The next sweep - which now includes it,
 * because scope is derived from the table - is what observes it. Claiming `open`
 * here would be inventing an observation.
 */
async function adoptReferences(
  teamId: string,
  references: PrIdentity[],
  known: Map<string, string>,
  now: string,
): Promise<number> {
  let created = 0;
  for (const ref of references) {
    if (created >= MAX_DISCOVERED_PER_SWEEP) {
      logger.warn({ cap: MAX_DISCOVERED_PER_SWEEP }, "sensing: cross-reference cap reached, the rest wait for the next sweep");
      break;
    }
    const externalId = prExternalId(ref);
    if (known.has(externalId)) continue;
    const { object, created: isNew } = await graph.getOrCreateMirror(undefined, {
      teamId,
      externalSource: PR_SOURCE,
      externalId,
      type: PR_TYPE,
      status: "observed",
      title: mirrorTitle({ ...ref, title: `#${ref.number}`, state: "open", merged: false, checks: "none", draft: false }),
      payload: { repo: ref.repo, number: ref.number, sourceUrl: prUrl(ref), discoveredBy: "cross-reference" },
      now,
    });
    known.set(externalId, object.id);
    if (isNew) {
      created++;
      logger.info({ mirror: object.id, pr: externalId }, "sensing: mirror created from a cross-reference");
    }
  }
  return created;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// ---- configuration ----

/** Poll cadence, `LOOPANY_GRAPH_POLL_MS`. */
export function pollIntervalMs(): number {
  const raw = Number(process.env.LOOPANY_GRAPH_POLL_MS?.trim());
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : DEFAULT_INTERVAL_MS;
}

/**
 * Is the live poller on? It reaches the network, so it is OPT-OUT in a local demo
 * and OPT-IN nowhere else: `LOOPANY_GRAPH_POLL=off` silences it (a demo with no
 * `gh` on PATH, an offline machine, a probe run), and anything else leaves it on
 * wherever the graph workspace itself exists. The workspace gate is what decides
 * whether this runs at all - see `boot.ts`.
 */
export function pollEnabled(): boolean {
  const v = process.env.LOOPANY_GRAPH_POLL?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  // Never in a test run unless asked: a probe must not reach GitHub by accident.
  if ((process.env.VITEST || process.env.NODE_ENV === "test") && v !== "on") return false;
  return true;
}

// ---- the background loop ----

interface Running {
  stop: () => void;
}

/**
 * ONE poller per process, guarded on `globalThis` exactly like the outbox
 * executor and the scheduler - dev HMR re-imports this module, and two sweeps
 * would double the API spend for no new facts. Correctness does not depend on the
 * guard (a second sweep would simply write nothing), tidiness does.
 */
const g = globalThis as unknown as { __loopanyMirrorPoller?: Running };

export function startMirrorPoller(
  options: { signal?: AbortSignal; intervalMs?: number; teamId?: string; fetcher?: PrFetcher } = {},
): Running {
  if (g.__loopanyMirrorPoller) return g.__loopanyMirrorPoller;

  const intervalMs = options.intervalMs ?? pollIntervalMs();
  let sweeping = false;
  const sweep = async () => {
    // Skip rather than queue: a sweep that outruns the cadence would otherwise
    // stack up passes contending for the same rows and the same rate limit.
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepOnce({
        now: new Date().toISOString(),
        ...(options.teamId ? { teamId: options.teamId } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
    } catch (err) {
      // A failed sweep is never fatal and never needs recovery: re-polling is
      // free, so the next tick is the retry.
      logger.error({ err: String(err) }, "sensing: sweep failed");
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();
  const running: Running = {
    stop: () => {
      clearInterval(timer);
      if (g.__loopanyMirrorPoller === running) g.__loopanyMirrorPoller = undefined;
    },
  };
  options.signal?.addEventListener("abort", () => running.stop(), { once: true });
  g.__loopanyMirrorPoller = running;

  // CATCH-UP: one immediate sweep before settling into the cadence, so a restart
  // does not leave the graph a whole interval stale. Fire-and-forget - boot must
  // not wait on the network.
  void sweep();

  logger.info({ intervalMs }, "mirror poller: started");
  return running;
}

export function stopMirrorPoller(): void {
  g.__loopanyMirrorPoller?.stop();
}
