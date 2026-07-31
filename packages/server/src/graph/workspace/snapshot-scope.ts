/**
 * SEED SCOPE - which of a production snapshot's loops actually get replayed.
 *
 * A snapshot is a whole team's fleet. A deployed demo often wants a SUBSET of it:
 * loopany-testing, for instance, runs one loop so the workspace can be shown, and
 * driven by a live machine agent, without carrying twenty-seven other loops'
 * reports (and their customers' correspondence) into an environment that exists
 * to exercise the shape rather than the content.
 *
 * That is a CONFIGURATION question, not a code question, which is why this module
 * exists at all: widening the scope later is one environment variable, and the
 * seeder keeps exactly one code path.
 *
 *   LOOPANY_GRAPH_SEED_LOOPS="React Doctor daily health, Housekeeper"
 *
 * UNSET (or empty) means the WHOLE snapshot, which is the historical behaviour and
 * the right default: a scope variable nobody set must never quietly shrink what an
 * operator asked for.
 *
 * ── two rules that keep this honest ─────────────────────────────────────────
 *
 * 1. MATCHING IS EXACT (on the loop's name, case-insensitively, or on its id).
 *    A substring rule would have made "React Doctor" silently also keep "React
 *    Doctor daily health", and a scope that keeps more than it was told to is
 *    worse than no scope at all.
 * 2. AN ENTRY THAT MATCHES NOTHING THROWS. A typo would otherwise seed an empty
 *    workspace that looks exactly like a broken deploy. The error names every
 *    loop in the snapshot, because that is the one thing the operator needs.
 *
 * The restriction is PURE and IDEMPOTENT - re-applying it to its own output is a
 * no-op - so it can run at more than one boundary (the route filters before it
 * fetches artifact bodies; the seeder filters again because it is the chokepoint
 * every caller passes through) without double-counting anything.
 */
import type { ProdSnapshot } from "./pull-prod.js";

/** The environment variable that names the kept loops. */
export const SEED_LOOPS_ENV = "LOOPANY_GRAPH_SEED_LOOPS";

export interface RestrictedSnapshot {
  snapshot: ProdSnapshot;
  /** The loop names actually kept, in snapshot order. */
  kept: string[];
  /** The loop names left behind. Empty when nothing was excluded. */
  excluded: string[];
}

/** `"a, b"` → `["a","b"]`; unset/blank → null, which means "no scope configured". */
export function configuredSeedLoops(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env[SEED_LOOPS_ENV]?.trim();
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length ? entries : null;
}

/**
 * Keep only the named loops, and everything that belongs to them.
 *
 * Runs and artifact files are carried by loop id, so nothing orphaned survives:
 * a run whose loop was excluded has no object to transition, and a file whose
 * loop was excluded has nothing to hang off.
 */
export function restrictSnapshot(snapshot: ProdSnapshot, keep: readonly string[]): RestrictedSnapshot {
  const wanted = keep.map((k) => k.trim()).filter(Boolean);
  if (!wanted.length) return { snapshot, kept: snapshot.loops.map((l) => l.name), excluded: [] };

  const wantedKeys = new Set(wanted.map((k) => k.toLowerCase()));
  const matched = new Set<string>();
  const loops = snapshot.loops.filter((l) => {
    const byName = l.name.trim().toLowerCase();
    const byId = l.id.trim().toLowerCase();
    const hit = wantedKeys.has(byName) || wantedKeys.has(byId);
    if (hit) {
      matched.add(wantedKeys.has(byName) ? byName : byId);
    }
    return hit;
  });

  const missed = wanted.filter((k) => !matched.has(k.toLowerCase()));
  if (missed.length) {
    throw new Error(
      `${SEED_LOOPS_ENV} names ${missed.length} loop(s) this snapshot does not contain: ${missed.join(", ")}. ` +
        `Available: ${snapshot.loops.map((l) => l.name).join(" | ")}`,
    );
  }

  const keptIds = new Set(loops.map((l) => l.id));
  const runs = snapshot.runs.filter((r) => keptIds.has(r.loopId));
  const files = snapshot.files.filter((f) => keptIds.has(f.loopId));
  const excluded = snapshot.loops.filter((l) => !keptIds.has(l.id)).map((l) => l.name);

  // What was left behind, and why - carried on the snapshot's own `dropped`
  // ledger so the seed result reports it exactly like every other omission.
  const why = `outside the ${SEED_LOOPS_ENV} scope (kept: ${loops.map((l) => l.name).join(", ")})`;
  const dropped = [...snapshot.dropped];
  const note = (what: string, count: number) => {
    if (count > 0) dropped.push({ what, count, why });
  };
  note("loops", excluded.length);
  note("runs", snapshot.runs.length - runs.length);
  note("artifact files", snapshot.files.length - files.length);

  return {
    snapshot: { ...snapshot, loops, runs, files, dropped },
    kept: loops.map((l) => l.name),
    excluded,
  };
}

/** `restrictSnapshot` under whatever the environment configured. A no-op when
 *  nothing is configured, so an unscoped deploy behaves exactly as before. */
export function restrictConfiguredSnapshot(
  snapshot: ProdSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): RestrictedSnapshot {
  const keep = configuredSeedLoops(env);
  if (!keep) return { snapshot, kept: snapshot.loops.map((l) => l.name), excluded: [] };
  return restrictSnapshot(snapshot, keep);
}
