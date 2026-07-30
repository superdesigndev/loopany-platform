/**
 * Graph Engineering v1 - SENSING, pipe 1: the pull-request fact vocabulary.
 *
 * This module is PURE (no db, no network, no clock) and it is where the whole
 * correctness of live ingestion is decided. Three things live here and nothing
 * else does:
 *
 *   1. MIRROR IDENTITY ↔ PR IDENTITY. A mirror is keyed by `external_id`
 *      (`owner/repo/pull/N`, design §7). The poller needs `{repo, number}` to
 *      ask GitHub, and the graph needs the external id back. Both directions are
 *      one function each, so the string format is spelled out ONCE.
 *   2. THE OBSERVED FACT SET. Exactly four facts are observed per PR - `state`,
 *      `merged`, `checks`, `title` - plus the mirror `status` they project onto.
 *      A closed set matters: the diff, the event ids and the mirror payload all
 *      enumerate the same list, so a fifth fact cannot be half-added.
 *   3. THE DEDUP KEY. `observationEventId` derives an event id from the fact's
 *      own identity, per design §12 item 6 ("a window is never a dedup key").
 *
 * ── why the event seed carries `from` as well as `to` ─────────────────────────
 *
 * The obvious seed is `(source, repo, number, field, newValue)`. It is not quite
 * enough, and the gap is not theoretical: a PR's checks go `pending → success →
 * pending` on every new push, and a merged PR can be reopened. With only the new
 * value in the seed, the SECOND arrival at `pending` collides with the first and
 * `ON CONFLICT DO NOTHING` swallows it - so the graph would keep a stale field
 * forever, silently, which is exactly the failure class this invariant exists to
 * prevent.
 *
 * Adding `from` makes the seed the identity of the CHANGE rather than of the
 * value, and it costs nothing the invariant cares about:
 *
 *   - it is not a clock and not a counter. It is the mirror's stored value, read
 *     under the row lock in the same transaction, so every derivation of the
 *     SAME change computes the same id;
 *   - a re-poll with no upstream change produces `from === to`, which is not a
 *     change at all and never reaches the id function - zero rows, forever;
 *   - a genuine flip back to a previous value is a genuine second event, which
 *     is the honest answer.
 *
 * This is a deliberate superset of the brief's field list, for the reason above.
 */
import { derivedEventId, mirrorObjectId } from "../ids.js";

/** The external system these facts come from - the mirror's `external_source`. */
export const PR_SOURCE = "github";

/** The registry type a pull-request mirror carries (`specs.ts` PULL_REQUEST_SPEC). */
export const PR_TYPE = "pull-request";

/**
 * Provenance of every observation this pipe writes. `entrance: "rule"` because a
 * freshness sweep is the engine's own declarative service, not a person, an
 * agent run or the cron (design §7: "per-machine system service, invisible in
 * the user graph"); the actor id names the concrete rule so the Timeline can
 * attribute a row to it.
 */
export const PR_POLLER_ACTOR = "rule-github-pr-poller";

/** The event kind an observation appends - the same kind the kernel's schema and
 *  invariant probes already name for an ingested external fact. */
export const OBSERVATION_EVENT = "external-changed";

// ---- identity ----

export interface PrIdentity {
  /** `owner/name`. */
  repo: string;
  number: number;
}

/** `owner/name/pull/N` - the mirror's `external_id`. One definition, both ways. */
export function prExternalId(id: PrIdentity): string {
  return `${id.repo}/pull/${id.number}`;
}

const EXTERNAL_ID = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

/**
 * Read a PR identity back out of a mirror's external id. Returns undefined for
 * anything that is not a pull-request external id - an issue mirror, a Linear
 * ticket, a malformed row - so the poller can only ever act on rows it
 * understands rather than guessing at a shape.
 */
export function parsePrExternalId(externalId: string | null | undefined): PrIdentity | undefined {
  const m = EXTERNAL_ID.exec((externalId ?? "").trim());
  if (!m) return undefined;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  return { repo: m[1]!, number };
}

/** The canonical web URL for a PR - what the Library's "View on GitHub" opens. */
export function prUrl(id: PrIdentity): string {
  return `https://github.com/${id.repo}/pull/${id.number}`;
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * Read a PR identity out of a pasted URL - the ONE place a GitHub URL shape is
 * understood, and it lives here because this module IS the GitHub accelerator
 * (captain decision 17: coded GitHub pieces are earned exceptions, never the
 * pattern). `mirror track` calls it first and falls back to the domain-neutral
 * `(source, externalId)` form for everything else, so no other source ever needs
 * a parser in platform code.
 *
 * Returns undefined for anything that is not a PR URL, including an issue URL -
 * guessing would register the wrong external thing under a type whose sensing
 * sweep then cannot observe it.
 */
export function parsePrUrl(url: string | null | undefined): PrIdentity | undefined {
  const m = PR_URL.exec((url ?? "").trim());
  if (!m) return undefined;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  return { repo: `${m[1]}/${m[2]}`, number };
}

/** The mirror OBJECT id a PR resolves to - the deterministic id
 *  `graphStore.getOrCreateMirror` mints, so a caller holding only a PR identity
 *  can address its mirror without a lookup. */
export function prMirrorId(teamId: string, id: PrIdentity): string {
  return mirrorObjectId(teamId, PR_SOURCE, prExternalId(id));
}

// ---- the observed fact set ----

/** GitHub's own PR state, lower-cased. `draft` is NOT one of these: a draft is
 *  still `open`, and folding it in would lose the distinction. */
export const PR_STATES = ["open", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];

/**
 * The checks summary, collapsed from GitHub's status-check rollup to the four
 * answers a graph reader can act on. `none` is a real answer (a repo with no CI
 * on that branch), NOT "unknown" - which is why it is a value rather than an
 * absent field.
 */
export const PR_CHECKS = ["passing", "failing", "pending", "none"] as const;
export type PrChecks = (typeof PR_CHECKS)[number];

/** One PR as observed upstream. Everything the poller reads and nothing more -
 *  a fetcher cannot smuggle an unobserved field into the graph. */
export interface ObservedPr extends PrIdentity {
  state: PrState;
  merged: boolean;
  checks: PrChecks;
  title: string;
  /** True while the PR is a draft. Carried because `open + draft` is a materially
   *  different situation from `open`, and it costs one boolean. */
  draft: boolean;
  /** Other PRs this one references in its body/title - the discovery half of
   *  §7's split. Absent when the fetcher did not read a body. */
  references?: PrIdentity[];
}

/**
 * The fields an observation may move on a mirror, in the order a reader wants to
 * see them. `status` is LAST and is different in kind: it is the mirror's
 * `objects.status` column, projected from the four facts above rather than
 * observed independently.
 */
export const OBSERVED_FIELDS = ["state", "merged", "checks", "title", "status"] as const;
export type ObservedField = (typeof OBSERVED_FIELDS)[number];

/**
 * Project the observed facts onto one of `PULL_REQUEST_SPEC`'s states.
 *
 * The spec's `checks-green` sits between `open` and `merged` because "open with
 * green CI" is the state a merge review actually waits on. A draft stays `open`:
 * green checks on a draft are not an invitation to merge.
 */
export function mirrorStatusFor(o: Pick<ObservedPr, "state" | "merged" | "checks" | "draft">): string {
  if (o.merged || o.state === "merged") return "merged";
  if (o.state === "closed") return "closed";
  if (!o.draft && o.checks === "passing") return "checks-green";
  return "open";
}

/** The mirror payload an observation writes. Keyed exactly like the observed
 *  fields, plus the identity the spec declares (`repo`, `number`) and the link
 *  the Library renders. Never spread over an unknown shape - the caller merges
 *  it onto the existing payload so unrelated keys (a seeder's `referencedBy`)
 *  survive. */
export function observedPayload(o: ObservedPr): Record<string, unknown> {
  return {
    repo: o.repo,
    number: o.number,
    state: o.state,
    merged: o.merged,
    checks: o.checks,
    title: o.title,
    draft: o.draft,
    sourceUrl: prUrl(o),
  };
}

/** The mirror's display title. Derived, so a title change shows up in the
 *  Library without a second stored copy of the format. */
export function mirrorTitle(o: ObservedPr): string {
  return `PR #${o.number} · ${o.title}`;
}

// ---- the diff: what actually changed ----

/** One observed field that moved. `from` is `null` when the mirror had never
 *  been observed for that field (the first sweep's normal case). */
export interface FieldChange {
  field: ObservedField;
  from: unknown;
  to: unknown;
}

/**
 * What this observation CHANGES about a mirror, and nothing more.
 *
 * The poller must be free to re-poll forever, so "no upstream change" has to
 * produce an empty list here - not an empty list two layers down. Equality is
 * structural over JSON scalars, which is all an observed fact ever is.
 *
 * `stored` is the mirror's current payload; `status` its current status column.
 */
export function diffObservation(
  stored: Record<string, unknown> | null | undefined,
  status: string,
  observed: ObservedPr,
): FieldChange[] {
  const payload = stored ?? {};
  const next: Record<ObservedField, unknown> = {
    state: observed.state,
    merged: observed.merged,
    checks: observed.checks,
    title: observed.title,
    status: mirrorStatusFor(observed),
  };
  const changes: FieldChange[] = [];
  for (const field of OBSERVED_FIELDS) {
    const from = field === "status" ? status : (payload[field] ?? null);
    const to = next[field];
    if (!sameFact(from, to)) changes.push({ field, from: from ?? null, to });
  }
  return changes;
}

/** Structural equality for an observed scalar. `undefined` and `null` are the
 *  same absence: a field the mirror has never carried is not "different from
 *  null", it is simply unobserved. */
function sameFact(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * THE DEDUP KEY (design §12 item 6). A pure function of the change's identity:
 * the source, the entity, the field and the transition of values. No clock, no
 * attempt counter, no nonce - so a re-derivation collides on the events primary
 * key and `ON CONFLICT DO NOTHING` makes the second insert a no-op, whether the
 * first landed a second or a year ago.
 */
export function observationEventId(id: PrIdentity, change: FieldChange): string {
  return derivedEventId({
    source: PR_SOURCE,
    repo: id.repo,
    number: id.number,
    field: change.field,
    from: change.from ?? null,
    to: change.to ?? null,
  });
}

// ---- external-wait conditions ----

/**
 * WHICH OBSERVATION DISCHARGES WHICH WAIT (design §12 item 5: waiting for the
 * external world to reflect a decision is an `external-wait` obligation, not a
 * gate).
 *
 * A `register-watch` action names its condition by KEY, and this closed table is
 * the only place a key becomes a predicate over observed facts. That is what
 * makes "a non-matching observation leaves the wait open" a property of the
 * system rather than an if-statement someone remembered to write: an obligation
 * whose condition is not in this table is never closed by a sweep, and a
 * condition that is in it is evaluated the same way everywhere.
 *
 * Predicates read the CURRENT observed facts, never the change list - "is the
 * world in the state we were waiting for?" is the question, and answering it
 * from a diff would make a wait that was opened one poll too late unclosable.
 */
export const WAIT_CONDITIONS = {
  /** The PR is merged. The M1 case: a captain approved a merge, and this is the
   *  world catching up. */
  merged: (o: ObservedPr) => o.merged || o.state === "merged",
  /** The PR is settled either way - merged or closed without merging. */
  resolved: (o: ObservedPr) => o.state !== "open",
  /** CI came back green. */
  "checks-green": (o: ObservedPr) => o.checks === "passing",
} as const satisfies Record<string, (o: ObservedPr) => boolean>;

export type WaitCondition = keyof typeof WAIT_CONDITIONS;

export function isWaitCondition(v: unknown): v is WaitCondition {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(WAIT_CONDITIONS, v);
}

/** Is the condition satisfied by these observed facts? An unknown condition is
 *  NOT satisfied - an obligation naming a condition this build does not
 *  understand stays open and stays visible, which is the safe direction. */
export function waitSatisfied(condition: string, observed: ObservedPr): boolean {
  return isWaitCondition(condition) ? WAIT_CONDITIONS[condition](observed) : false;
}

/**
 * THE KEY CONVENTION. An `external-wait` obligation carries its condition in its
 * KEY: `merge-wait` means the default `merged`, `merge-wait:checks-green` names
 * one explicitly.
 *
 * The binding lives on the row rather than in a side table because the row is
 * what a sweep has in hand (decision 3: obligations are keyed `(objectId, key)`,
 * and `label` is prose for a human). One parse, one place.
 */
export function conditionOf(key: string): string {
  const at = key.indexOf(":");
  return at === -1 ? "merged" : key.slice(at + 1);
}

/**
 * Read the observed facts back off a mirror's stored payload - the inverse of
 * `observedPayload`. Returns undefined when the mirror has never been observed
 * (no `state` recorded), so a caller can tell "not merged" from "we have not
 * looked yet", which are very different answers to "may I stop waiting?".
 */
export function observedFromPayload(mirror: {
  externalId: string | null;
  payload: Record<string, unknown> | null;
}): ObservedPr | undefined {
  const identity = parsePrExternalId(mirror.externalId);
  const p = mirror.payload ?? {};
  const state = p.state;
  if (!identity || typeof state !== "string" || !(PR_STATES as readonly string[]).includes(state)) return undefined;
  const checks = typeof p.checks === "string" && (PR_CHECKS as readonly string[]).includes(p.checks) ? (p.checks as PrChecks) : "none";
  return {
    ...identity,
    state: state as PrState,
    merged: p.merged === true,
    checks,
    title: typeof p.title === "string" ? p.title : `PR #${identity.number}`,
    draft: p.draft === true,
  };
}

// ---- cross-references (the discovery half) ----

const PR_URL_REF = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const SHORT_REF = /(?:^|[^\w/#])#(\d{1,7})\b/g;

/**
 * PRs referenced from this one's prose - a full URL anywhere, or a bare `#N`
 * resolved against the SAME repo (a `#N` in a PR body means "this repo" on
 * GitHub, and guessing any other repo would invent a fact).
 *
 * Deliberately text-only and bounded. A real cross-reference graph lives in
 * GitHub's timeline API; this is the cheap, honest subset that comes free with
 * bytes the sweep already fetched, and `max` keeps a body that lists forty PRs
 * from turning one observation into forty mirrors.
 */
export function referencedPrs(self: PrIdentity, text: string | null | undefined, max = 5): PrIdentity[] {
  const body = text ?? "";
  const out: PrIdentity[] = [];
  const seen = new Set<string>([prExternalId(self)]);
  const push = (repo: string, number: number) => {
    if (out.length >= max) return;
    const id = { repo, number };
    const key = prExternalId(id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(id);
  };
  PR_URL_REF.lastIndex = 0;
  for (const m of body.matchAll(PR_URL_REF)) push(m[1]!, Number(m[2]));
  SHORT_REF.lastIndex = 0;
  for (const m of body.matchAll(SHORT_REF)) push(self.repo, Number(m[1]));
  return out;
}
