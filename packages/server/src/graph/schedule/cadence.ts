/**
 * Graph Engineering v1 - THE CADENCE: schedules as data, and the arithmetic on them.
 *
 * PURE. No database, no clock, no I/O: every function takes the instant it should
 * reason from, exactly like `applyTransition` and the outbox executor do (design
 * §12 item 8 - "transitions never read the clock; a `now` is passed in"). That is
 * what lets the catch-up and jitter probes assert real instants instead of hoping
 * about timing.
 *
 * ── two forms, one meaning ──────────────────────────────────────────────────
 *
 *   CRON      a cron expression, read in the object's own timezone. What a person
 *             writes when the cadence is a wall-clock fact ("every morning at 7").
 *   INTERVAL  a fixed number of milliseconds on an EPOCH-ANCHORED grid. What a
 *             person writes when the cadence is a rate ("every 90 seconds"), which
 *             cron cannot express below a minute or off the minute boundary.
 *
 * The interval form is anchored on the epoch rather than on the previous fire on
 * purpose: an interval measured from the last fire DRIFTS (every late fire pushes
 * the next one later, forever), and a schedule that slowly walks away from the time
 * it was set to is the kind of bug nobody notices for a month.
 *
 * ── jitter is DETERMINISTIC ─────────────────────────────────────────────────
 *
 * `0 7 * * *` on forty objects means forty fires in the same second, forty runs
 * dispatched at once, and one machine trying to serve them. So every object gets a
 * fixed offset inside a bounded window, derived from its OWN ID by hash - which
 * means it is stable across restarts and across recomputes. Random jitter would
 * spread the load equally well and make "when will this fire?" unanswerable, and a
 * cursor that moved every time it was recomputed could never be reasoned about.
 *
 * ── the level-triggered rule lives here ─────────────────────────────────────
 *
 * `nextFireAfter(spec, after)` answers "when is the next fire STRICTLY after this
 * instant". Feed it NOW and missed occurrences collapse: three intervals of
 * downtime produce ONE due fire, because the debt is a level ("you are due"), not a
 * count of edges ("you owe three ticks"). Nothing here can produce a back-fire.
 */
import { Cron } from "croner";

import { contentHash } from "../ids.js";

/** A cadence, as stored on an object. Exactly one form is set. */
export interface CadenceSpec {
  /** Cron expression, read in `timezone`. */
  cron?: string | null;
  /** Fixed interval in ms, on an epoch-anchored grid. */
  intervalMs?: number | null;
  /** IANA zone the cron is read in. Null ⇒ the server's own zone. */
  timezone?: string | null;
}

/**
 * How wide the deterministic jitter window is. Two minutes: big enough to spread a
 * whole fleet's 07:00 fires over a real span, small enough that a person reading
 * "daily at 07:00" is not surprised by the instant it actually happens.
 */
export const JITTER_WINDOW_MS = 120_000;

/** The smallest interval a cadence may declare. A schedule that fires faster than
 *  the scheduler ticks is not a cadence, it is a busy loop with extra steps. */
export const MIN_INTERVAL_MS = 5_000;

/** Ceiling on interval parsing, so a typo cannot ask for a cadence measured in
 *  centuries and quietly become "never fires again". */
export const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

export type CadenceParse = { ok: true; spec: CadenceSpec } | { ok: false; why: string };

/**
 * Parse and VALIDATE a cadence declaration. Refuses rather than defaults: a
 * schedule nobody can compute a next fire for must not be armed as if it could be,
 * because the failure would then be silent - an object that simply never fires.
 */
export function parseCadence(input: {
  cron?: string | null;
  interval?: string | number | null;
  timezone?: string | null;
}): CadenceParse {
  const cron = typeof input.cron === "string" && input.cron.trim() ? input.cron.trim() : undefined;
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : undefined;

  const interval = input.interval == null || input.interval === "" ? undefined : parseInterval(input.interval);
  if (input.interval != null && input.interval !== "" && interval === undefined) {
    return { ok: false, why: `"${String(input.interval)}" is not an interval - use 90s, 5m, 2h, 1d or a count of ms` };
  }

  if (cron && interval !== undefined) {
    return { ok: false, why: "a cadence is a cron expression OR an interval, never both" };
  }
  if (!cron && interval === undefined) return { ok: false, why: "a cadence needs a cron expression or an interval" };

  if (interval !== undefined) {
    if (interval < MIN_INTERVAL_MS) return { ok: false, why: `an interval must be at least ${MIN_INTERVAL_MS}ms` };
    if (interval > MAX_INTERVAL_MS) return { ok: false, why: `an interval must be at most ${MAX_INTERVAL_MS}ms` };
    return { ok: true, spec: { intervalMs: interval, ...(timezone ? { timezone } : {}) } };
  }

  const probe = probeCron(cron!, timezone);
  if (!probe.ok) return probe;
  return { ok: true, spec: { cron, ...(timezone ? { timezone } : {}) } };
}

/** `90s` / `5m` / `2h` / `1d` / a bare count of ms → ms. Undefined when it is
 *  none of those - an unparseable interval is refused, never guessed at. */
export function parseInterval(raw: string | number): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  const text = raw.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = m[2] ?? "ms";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.floor(value * factor);
}

function probeCron(expr: string, timezone?: string | null): { ok: true } | { ok: false; why: string } {
  try {
    const probe = new Cron(expr, { paused: true, ...(timezone ? { timezone } : {}) });
    const next = probe.nextRun();
    probe.stop();
    if (!next) return { ok: false, why: `cron expression "${expr}" never fires again` };
    return { ok: true };
  } catch (err) {
    return { ok: false, why: `cron expression "${expr}" is invalid: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * This object's fixed offset inside the jitter window. A pure function of the id,
 * so it is the same on every server, after every restart, and on every recompute -
 * which is what makes a jittered `next_fire` a promise rather than a guess.
 */
export function jitterMsFor(objectId: string, window = JITTER_WINDOW_MS): number {
  if (window <= 0) return 0;
  // 13 hex digits ≈ 52 bits: comfortably inside the exact-integer range, so the
  // modulo is uniform enough for load spreading and never loses precision.
  const bucket = Number.parseInt(contentHash({ jitter: objectId }).slice(0, 13), 16);
  return bucket % window;
}

/** Is this spec a cadence at all? */
export function hasCadence(spec: CadenceSpec): boolean {
  return Boolean(spec.cron) || (typeof spec.intervalMs === "number" && spec.intervalMs > 0);
}

/**
 * The next fire STRICTLY AFTER `afterIso`, jitter included, or undefined when the
 * cadence has no future occurrence.
 *
 * Feed it the object's current cursor to schedule the following fire; feed it NOW
 * to collapse a backlog into one due fire. That single choice is the whole
 * catch-up semantics, which is why it is a parameter and not a policy baked in
 * here: the SCHEDULER decides which instant it is reasoning from, and it always
 * reasons from now (see `scheduler.ts advance`).
 */
export function nextFireAfter(spec: CadenceSpec, afterIso: string, objectId: string): string | undefined {
  const after = Date.parse(afterIso);
  if (Number.isNaN(after)) return undefined;
  const jitter = jitterMsFor(objectId);

  // The jitter shifts a fire LATER, so an occurrence whose jittered instant has
  // already passed must be stepped over rather than returned - otherwise the
  // cursor could be set to an instant already in the past and the object would be
  // instantly due again. Bounded, so a pathological cadence terminates.
  let cursor = after;
  for (let attempt = 0; attempt < 8; attempt++) {
    const occurrence = nextOccurrence(spec, cursor);
    if (occurrence === undefined) return undefined;
    const fire = occurrence + jitter;
    if (fire > after) return new Date(fire).toISOString();
    cursor = occurrence;
  }
  return undefined;
}

/** The raw (un-jittered) occurrence strictly after `fromMs`. */
function nextOccurrence(spec: CadenceSpec, fromMs: number): number | undefined {
  if (typeof spec.intervalMs === "number" && spec.intervalMs > 0) {
    // EPOCH-ANCHORED: the grid is `k · interval`, so a late fire never moves the
    // grid and the cadence cannot drift. `floor + 1` makes it strictly after.
    const step = Math.floor(spec.intervalMs);
    return (Math.floor(fromMs / step) + 1) * step;
  }
  if (!spec.cron) return undefined;
  try {
    const probe = new Cron(spec.cron, { paused: true, ...(spec.timezone ? { timezone: spec.timezone } : {}) });
    const next = probe.nextRun(new Date(fromMs));
    probe.stop();
    return next ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

/** One line naming the cadence, for the workspace and the CLI. */
export function describeCadence(spec: CadenceSpec): string {
  if (spec.cron) return spec.timezone ? `${spec.cron} (${spec.timezone})` : spec.cron;
  const ms = typeof spec.intervalMs === "number" ? spec.intervalMs : 0;
  if (!ms) return "no cadence";
  if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `every ${ms / 1_000}s`;
  return `every ${ms}ms`;
}

/** The CADENCE of an object row - the two columns read as one value. */
export function cadenceOf(row: { cron: string | null; intervalMs: number | null; timezone: string | null }): CadenceSpec {
  return { cron: row.cron, intervalMs: row.intervalMs, timezone: row.timezone };
}
