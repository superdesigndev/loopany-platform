/**
 * Graph Engineering v1 - SENSING, pipe 1: THE SERVER'S HALF.
 *
 * Captain decision 10: all external observation executes on the user's machine
 * with the user's credentials, mirroring effect delivery's "effects run where
 * credentials live". So the server keeps exactly TWO things and nothing else:
 *
 *   1. THE WATCH LIST - "these are the pull-request mirrors this team holds".
 *      Its scope is a query over our OWN tables, never a GitHub search, so it can
 *      never widen on its own (design §7's freshness/discovery split: freshness
 *      scope is derived mechanically from the watch list). `watchList` below.
 *   2. THE OBSERVATION SEAM - `sensing/observe.ts recordObservation`, unchanged.
 *      `ingestObservations` below is a thin batch wrapper over it plus the
 *      cross-reference adoption the old sweep did.
 *
 * WHAT IS GONE, DELIBERATELY: the fetch loop. There is no `gh` here, no GraphQL,
 * no HTTP client, no `startMirrorPoller`, and no dev-mode exception (the captain
 * explicitly declined one) - so a local demo runs the real topology, with a
 * machine agent process alongside the dev server. `sensing.integration.test.ts`
 * pins the absence with a source scan, because "the server never fetches" is
 * exactly the kind of invariant that erodes one convenient import at a time.
 *
 * ── the transport moved; NOTHING about identity did ──────────────────────────
 *
 * Every observation's event ids are derived from the fact's own identity
 * (`sensing/pr.ts observationEventId`), so who fetched the bytes is invisible to
 * dedup: a re-report of the same facts collides on the primary key and inserts
 * zero rows, whether the reporter is this process, an agent, or the same agent
 * twice after a crash. Provenance semantics are likewise untouched - `entrance:
 * "rule"`, actor `PR_POLLER_ACTOR`, because a freshness sweep is still the
 * engine's own declarative service and not the person or the agent run that
 * happened to carry its bytes. The transport changed; the meaning did not.
 *
 * ── the clock ───────────────────────────────────────────────────────────────
 *
 * `now` is passed in. Same discipline as `applyTransition`, the outbox executor
 * and the directive channel: the route reads the clock, so a probe can replay an
 * observation at a chosen instant without fake timers.
 */
import { logger } from "../../logger.js";
import * as graph from "../../db/graphStore.js";
import { MAX_DISCOVERED_PER_REPORT, MAX_OBSERVATIONS_PER_REPORT, WATCH_LIST_LIMIT } from "../agent/config.js";
import { DEMO_TEAM_ID } from "../workspace/specs.js";
import { recordObservation } from "./observe.js";
import {
  PR_SOURCE,
  PR_TYPE,
  mirrorTitle,
  parsePrExternalId,
  prExternalId,
  prUrl,
  type ObservedPr,
  type PrIdentity,
} from "./pr.js";

// ---- the watch list ----

/** One entry the agent is asked to keep fresh. Flat and self-contained: the agent
 *  never queries the graph, so everything it needs to build a batched request is
 *  here. */
export interface WatchItem {
  /** The mirror object id, so a reported observation can be matched back to a row
   *  without the agent having to know how mirror ids are minted. */
  objectId: string;
  /** `owner/repo/pull/N` - the mirror's own external id. */
  externalId: string;
  repo: string;
  number: number;
  /** When this mirror was last observed, so an agent can prioritize the stalest
   *  ones when a large list is capped. Null ⇒ never observed. */
  observedAt: string | null;
}

export interface WatchListResult {
  teamId: string;
  /** The external system every item belongs to. One source per list, because a
   *  fetch transport is per-source and mixing them would push that branch onto
   *  the agent for no gain. */
  source: string;
  items: WatchItem[];
  /** True when the list was capped - so the agent reports a partial sweep as
   *  partial rather than as "these are all the mirrors there are". */
  truncated: boolean;
}

/**
 * The pull-request mirrors this team holds.
 *
 * A mirror whose `external_id` is not a pull request (an issue mirror, a Linear
 * ticket, a malformed row) is DROPPED here rather than handed over: the agent can
 * only act on rows it understands, and deciding that is the server's job because
 * the server is what knows the id format.
 */
export async function watchList(input: { teamId?: string; limit?: number } = {}): Promise<WatchListResult> {
  const teamId = input.teamId ?? DEMO_TEAM_ID;
  const limit = Math.min(Math.max(input.limit ?? WATCH_LIST_LIMIT, 1), WATCH_LIST_LIMIT);
  // Ask for one more than we will serve, so "was this capped?" is answered by the
  // query rather than guessed from a full page.
  const mirrors = await graph.listMirrors(undefined, teamId, {
    externalSource: PR_SOURCE,
    type: PR_TYPE,
    limit: limit + 1,
  });
  const truncated = mirrors.length > limit;

  const items: WatchItem[] = [];
  for (const m of mirrors.slice(0, limit)) {
    const id = parsePrExternalId(m.externalId);
    if (!id) continue;
    items.push({
      objectId: m.id,
      externalId: prExternalId(id),
      repo: id.repo,
      number: id.number,
      observedAt: m.externalObservedAt,
    });
  }
  return { teamId, source: PR_SOURCE, items, truncated };
}

// ---- the observation report ----

/** One mirror the agent's transport could not resolve, and why. Surfaced rather
 *  than dropped: a PR that stopped resolving is a fact about the world too. */
export interface UnresolvedReport {
  externalId: string;
  why: string;
}

export interface IngestInput {
  /** ISO instant. REQUIRED - this module never reads a clock. */
  now: string;
  teamId?: string;
  /** The facts the agent read, in any order. Matched to mirrors by IDENTITY
   *  (`repo`/`number`), never by position in the array. */
  observations: ObservedPr[];
  /** What the agent asked for and did not get. */
  unresolved?: UnresolvedReport[];
  /** Provenance actor for the observations. Defaults to the poller rule, which is
   *  what keeps provenance semantics identical to the in-server sweep. */
  actorId?: string;
}

export interface IngestResult {
  /** Mirrors on this team's watch list right now - the scope the report was
   *  against, so a caller can see coverage without a second call. */
  mirrors: number;
  /** Observations the agent reported. */
  reported: number;
  /** Reported facts that named no mirror we hold - counted, not written. */
  unknown: number;
  /** Mirrors an observation actually moved. */
  changed: number;
  /** Derived event rows this report INSERTED. A re-report makes this zero, which
   *  is the property the whole pipe rests on. */
  events: number;
  /** external-wait obligations discharged by an observation. */
  waitsClosed: number;
  /** Mirrors created from a cross-reference. */
  discovered: number;
  /** Observations the seam refused, with its typed code. */
  refusals: string[];
  /** Echoed back so the agent's log and the server's log say the same thing. */
  unresolved: UnresolvedReport[];
  /** True when the report carried more observations than one call accepts. The
   *  overflow is DROPPED and said so - a silent truncation would read as a clean
   *  sweep that covered everything. */
  capped: boolean;
}

/**
 * Ingest ONE reported sweep.
 *
 * Structurally the same pass the in-server poller made, minus the fetch: resolve
 * each reported fact to a mirror we hold, run it through `recordObservation` (one
 * transaction each, the actor-mailbox lock inside), then adopt cross-references.
 * Nothing is skipped on the grounds of having been observed recently - a re-report
 * of unchanged facts costs one comparison and writes nothing.
 *
 * A fact for a mirror we do NOT hold is counted and dropped, never created: a
 * report is not a discovery channel. New mirrors arrive exactly one way - through
 * `adoptReferences` below, from a reference inside a PR we already watch - so an
 * agent cannot widen the graph's scope by reporting whatever it likes.
 */
export async function ingestObservations(input: IngestInput): Promise<IngestResult> {
  const teamId = input.teamId ?? DEMO_TEAM_ID;
  const now = input.now;
  const unresolved = input.unresolved ?? [];
  const capped = input.observations.length > MAX_OBSERVATIONS_PER_REPORT;
  const observations = capped ? input.observations.slice(0, MAX_OBSERVATIONS_PER_REPORT) : input.observations;

  const watch = await watchList({ teamId });
  const result: IngestResult = {
    mirrors: watch.items.length,
    reported: observations.length,
    unknown: 0,
    changed: 0,
    events: 0,
    waitsClosed: 0,
    discovered: 0,
    refusals: [],
    unresolved,
    capped,
  };

  /** external id → mirror object id, so a reported fact maps back to a row. */
  const byExternalId = new Map<string, string>();
  for (const item of watch.items) byExternalId.set(item.externalId, item.objectId);

  /** Cross-referenced PRs seen in this report, deduped before any write. */
  const referenced = new Map<string, PrIdentity>();

  for (const observed of observations) {
    const externalId = prExternalId(observed);
    const objectId = byExternalId.get(externalId);
    if (!objectId) {
      // Reported but not mirrored. Either the mirror was deleted while the sweep
      // was in flight, or the agent reported something nobody asked for. Both are
      // "nothing to write", and both are worth counting.
      result.unknown++;
      continue;
    }
    const outcome = await recordObservation({
      objectId,
      observed,
      now,
      ...(input.actorId ? { actorId: input.actorId } : {}),
    });
    if (!outcome.ok) {
      result.refusals.push(`${externalId}: ${outcome.code} - ${outcome.message}`);
      continue;
    }
    // `events` counts INSERTED rows, so a replayed report reports zero even
    // though it derived the same ids.
    const inserted = outcome.replay ? 0 : outcome.events.length;
    if (inserted) result.changed++;
    result.events += inserted;
    result.waitsClosed += outcome.closed.length;
    for (const ref of observed.references ?? []) referenced.set(prExternalId(ref), ref);
  }

  result.discovered = await adoptReferences(teamId, [...referenced.values()], byExternalId, now);

  for (const u of unresolved) {
    logger.warn({ team: teamId, pr: u.externalId, why: u.why }, "sensing: agent could not resolve a watched mirror");
  }
  if (capped) {
    logger.warn(
      { team: teamId, accepted: MAX_OBSERVATIONS_PER_REPORT, reported: input.observations.length },
      "sensing: observation report capped - the overflow was dropped and will be re-reported next sweep",
    );
  }
  logger.info(
    {
      team: teamId,
      mirrors: result.mirrors,
      reported: result.reported,
      changed: result.changed,
      events: result.events,
      waitsClosed: result.waitsClosed,
      discovered: result.discovered,
      unknown: result.unknown,
      unresolved: unresolved.length,
    },
    "sensing: observation report ingested",
  );
  return result;
}

/**
 * Get-or-create a mirror for every cross-referenced PR we do not hold yet -
 * requirement 3 of pipe 1, unchanged in meaning by the transport move.
 *
 * Straight onto the EXISTING upsert path (`graphStore.getOrCreateMirror`), which
 * is an upsert on the deterministic mirror id and never a read-then-write - so N
 * concurrent reports discovering the same PR converge on ONE row (design §7's
 * day-one invariant, probed directly in `graphInvariants`).
 *
 * The new mirror lands at status `observed` with NO observed facts: we learned it
 * exists, we did not read its state. The NEXT sweep - which now includes it,
 * because the watch list is derived from the table - is what observes it. Claiming
 * `open` here would be inventing an observation.
 */
async function adoptReferences(
  teamId: string,
  references: PrIdentity[],
  known: Map<string, string>,
  now: string,
): Promise<number> {
  let created = 0;
  for (const ref of references) {
    if (created >= MAX_DISCOVERED_PER_REPORT) {
      logger.warn(
        { cap: MAX_DISCOVERED_PER_REPORT },
        "sensing: cross-reference cap reached, the rest wait for the next sweep",
      );
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

// ---- freshness, for the workspace ----

/** How stale a mirror may be before the workspace calls it out. Generous relative
 *  to any sane agent cadence: this answers "is anybody sensing at all?", not "did
 *  the last sweep land on time". */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export interface SensingHealth {
  /** Mirrors on the watch list. */
  mirrors: number;
  /** Mirrors that have never been observed. */
  unobserved: number;
  /** Observed, but longer ago than `STALE_AFTER_MS`. */
  stale: number;
  /** The most recent observation across the watch list. Null when none. */
  lastObservedAt: string | null;
}

/**
 * Is the workspace being sensed?
 *
 * This is the surface that makes "the server never touches GitHub" honest to look
 * at. With the fetch loop gone, a workspace whose agent is not running looks
 * exactly like one whose PRs simply have not changed - and those are very
 * different situations. Computed from `objects.external_observed_at`, so it is a
 * property of real rows and not a heartbeat somebody has to remember to send.
 */
export async function sensingHealth(input: { now: string; teamId?: string }): Promise<SensingHealth> {
  const { items } = await watchList({ ...(input.teamId ? { teamId: input.teamId } : {}) });
  const nowMs = Date.parse(input.now);
  let unobserved = 0;
  let stale = 0;
  let newest: number | null = null;
  for (const item of items) {
    if (!item.observedAt) {
      unobserved++;
      continue;
    }
    const ms = Date.parse(item.observedAt);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
    if (Number.isFinite(nowMs) && nowMs - ms > STALE_AFTER_MS) stale++;
  }
  return {
    mirrors: items.length,
    unobserved,
    stale,
    lastObservedAt: newest === null ? null : new Date(newest).toISOString(),
  };
}
