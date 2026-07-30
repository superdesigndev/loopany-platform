/**
 * SENSING - the machine half of pipe 1, and the whole of the fetch loop.
 *
 * Captain decision 10: all external observation executes on the user's machine with
 * the user's credentials, mirroring effect delivery's "effects run where credentials
 * live". This module is where the code that used to live in the SERVER
 * (`graph/sensing/fetch-gh.ts` + `poller.ts`, both now deleted) actually runs:
 *
 *   1. pull the WATCH LIST from the server ("these are the pull-request mirrors this
 *      team holds") - a query over the server's own tables, so the scope can never
 *      widen on its own;
 *   2. BATCH BY REPO and fetch with LOCAL `gh` credentials - one GraphQL query per
 *      repo-chunk, at a small fixed concurrency, stopping early on a low rate-limit
 *      budget;
 *   3. REPORT the observations back through the observation seam.
 *
 * Three reasons this had to move, all of them structural rather than stylistic:
 * private repositories are unreadable from the server at all; one shared server-side
 * GitHub quota cannot scale past a handful of teams; and a machine-side sensor can
 * observe things a server never could reach (local hardware, private analytics).
 *
 * ── the transport moved; NOTHING about identity did ──────────────────────────
 *
 * Derived event ids are content-derived on the SERVER, from the fact's own identity.
 * So who fetched the bytes is invisible to dedup: reporting the same facts twice
 * inserts zero rows, and a sweep killed halfway costs nothing because the next one
 * observes the same facts and collides. There is no cursor here, no high-water mark
 * and no "last polled" gate - which is why this module has no recovery path to get
 * wrong.
 *
 * ── read-only by construction ───────────────────────────────────────────────
 *
 * The only statement it can issue is the GraphQL `query` in `gh.ts fetchPrs`. There
 * is no mutation text on this path at all, `gh` is invoked with a fixed argv and no
 * work-order data in it, and the response is bounded. The WRITE side of GitHub lives
 * in the effect path, behind an approval.
 */
import type { AgentConfig } from "./config.js";
import type { Gh, PrBatch } from "./gh.js";
import type { ObservationReportResponse, ObservedPr, WatchItem, WatchListResponse } from "./types.js";

/** Repos fetched concurrently. Small on purpose: a freshness sweep is background
 *  work, and a burst of parallel API calls buys nothing. */
export const REPO_CONCURRENCY = 3;

/** Below this remaining rate-limit budget the sweep stops early rather than spending
 *  the last of a shared quota on a background refresh. Stopping is safe by
 *  construction: the mirrors we did not reach keep their old facts and the next sweep
 *  observes them. */
export const RATE_LIMIT_FLOOR = 100;

export interface SweepResult {
  /** Mirrors the watch list offered. */
  watched: number;
  /** Repos the sweep batched into. */
  repos: number;
  /** Observations reported to the server. */
  reported: number;
  /** Mirrors an observation actually moved, as the SERVER counted them. */
  changed: number;
  /** Derived event rows the report inserted. Zero on a re-report, which is the
   *  property the whole pipe rests on. */
  events: number;
  waitsClosed: number;
  discovered: number;
  /** Mirrors the transport could not resolve, and why - surfaced, never dropped. */
  unresolved: { externalId: string; why: string }[];
  /** Observations the server's seam refused, with its typed code. */
  refusals: string[];
  /** Remaining GraphQL budget, when the transport reported one. */
  rateLimitRemaining?: number;
  /** True when the sweep stopped early to protect a shared rate-limit budget. */
  rateLimited: boolean;
  /** True when the watch list itself was capped - so a partial sweep reads as
   *  partial rather than as "these are all the mirrors there are". */
  truncated: boolean;
}

/** The two server calls a sweep makes. Injected, so every probe drives the whole
 *  sweep - batching, rate-limit stop, discovery - with no network. */
export interface SensingDeps {
  gh: Gh;
  watchList: () => Promise<WatchListResponse>;
  report: (input: {
    observations: ObservedPr[];
    unresolved: { externalId: string; why: string }[];
  }) => Promise<ObservationReportResponse>;
  log: (line: string) => void;
}

/**
 * ONE freshness sweep.
 *
 * Nothing is skipped on the grounds of having been observed recently: a re-read of an
 * unchanged PR costs one comparison server-side and writes nothing, which is exactly
 * what the dedup invariant buys. An empty watch list is a clean no-op that makes no
 * network calls at all.
 */
export async function sweepOnce(config: AgentConfig, deps: SensingDeps): Promise<SweepResult> {
  const list = await deps.watchList();
  const result: SweepResult = {
    watched: list.items.length,
    repos: 0,
    reported: 0,
    changed: 0,
    events: 0,
    waitsClosed: 0,
    discovered: 0,
    unresolved: [],
    refusals: [],
    rateLimited: false,
    truncated: list.truncated,
  };
  if (!list.items.length) return result;

  const batches = groupByRepo(list.items);
  result.repos = batches.size;

  const observations: ObservedPr[] = [];

  for (const group of chunks([...batches.entries()], REPO_CONCURRENCY)) {
    const fetched = await Promise.all(
      group.map(async ([repo, numbers]): Promise<{ repo: string; batch: PrBatch }> => {
        try {
          return { repo, batch: await deps.gh.fetchPrs(repo, numbers) };
        } catch (err) {
          // A repo whose fetch threw is REPORTED, not swallowed: every number in it
          // comes back unresolved so the sweep's own account is honest about the gap.
          const why = errText(err);
          deps.log(`! ${repo}: fetch failed — ${why}`);
          return { repo, batch: { observed: new Map(), missing: numbers.map((n) => ({ number: n, why })) } };
        }
      }),
    );

    for (const { repo, batch } of fetched) {
      if (typeof batch.rateLimitRemaining === "number") result.rateLimitRemaining = batch.rateLimitRemaining;
      for (const miss of batch.missing) {
        result.unresolved.push({ externalId: `${repo}/pull/${miss.number}`, why: miss.why });
      }
      for (const observed of batch.observed.values()) observations.push(observed);
    }

    if (typeof result.rateLimitRemaining === "number" && result.rateLimitRemaining < RATE_LIMIT_FLOOR) {
      result.rateLimited = true;
      deps.log(`! stopping the sweep early: ${result.rateLimitRemaining} GraphQL units left, floor is ${RATE_LIMIT_FLOOR}`);
      break;
    }
  }

  result.reported = observations.length;
  // Report even when nothing was observed but something was unresolved: "we could not
  // read these" is a fact about the world the server should hear.
  if (!observations.length && !result.unresolved.length) return result;

  const ingested = await deps.report({ observations, unresolved: result.unresolved });
  result.changed = ingested.changed;
  result.events = ingested.events;
  result.waitsClosed = ingested.waitsClosed;
  result.discovered = ingested.discovered;
  result.refusals = ingested.refusals;
  if (ingested.capped) {
    deps.log(`! the server capped this report — the overflow will be re-reported on the next sweep`);
  }
  return result;
}

/**
 * Group watch items into `repo → numbers` - the batch shape the fetcher takes.
 *
 * REST would be one request per PR (20 mirrors ⇒ 20 requests, 20 rate-limit units).
 * One GraphQL query with an aliased field per PR fetches a whole repo's worth for a
 * cost of 1, and the same call returns the live `rateLimit` block - so the sweep
 * knows its remaining budget from the response rather than from a guess.
 */
export function groupByRepo(items: WatchItem[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const item of items) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repo)) continue;
    if (!Number.isSafeInteger(item.number) || item.number <= 0) continue;
    const list = out.get(item.repo) ?? [];
    if (!list.includes(item.number)) list.push(item.number);
    out.set(item.repo, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 400);
}

/** One line summarising a sweep, for the agent's own log. */
export function describeSweep(s: SweepResult): string {
  if (!s.watched) return "sensing: nothing on the watch list";
  const bits = [
    `${s.watched} watched`,
    `${s.repos} repo${s.repos === 1 ? "" : "s"}`,
    `${s.changed} moved`,
    `${s.events} event${s.events === 1 ? "" : "s"}`,
  ];
  if (s.waitsClosed) bits.push(`${s.waitsClosed} wait${s.waitsClosed === 1 ? "" : "s"} closed`);
  if (s.discovered) bits.push(`${s.discovered} discovered`);
  if (s.unresolved.length) bits.push(`${s.unresolved.length} unresolved`);
  if (s.refusals.length) bits.push(`${s.refusals.length} refused`);
  if (s.rateLimited) bits.push("STOPPED EARLY on rate limit");
  if (s.truncated) bits.push("watch list capped");
  return `sensing: ${bits.join(" · ")}`;
}
