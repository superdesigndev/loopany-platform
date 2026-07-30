/**
 * THE RUN CREDENTIAL - who a `graph` CLI call is, and what it may do.
 *
 * Captain decision 15 moves workflow SEQUENCING into the agent: a run does its
 * work by calling seven CLI verbs, each a thin wrapper over `applyTransition` and
 * the observation seam. Every one of those calls needs an identity, and the
 * identity has to satisfy three things at once:
 *
 *   1. it must name the RUN, because that is the provenance every write it makes
 *      carries (`entrance: "agent-run"`, actor id = run id - design §12);
 *   2. it must be UNFORGEABLE from inside the run, or "an agent run may write to
 *      the graph" would mean "anything on that laptop may write to the graph";
 *   3. it must NOT be the channel token. The machine agent deliberately hands a
 *      run an allowlisted environment (`machine-agent/src/run.ts` `INHERITED_ENV`)
 *      precisely so its own credential does not travel into a model's context.
 *
 * ── the token is DERIVED, not minted ────────────────────────────────────────
 *
 *   runCliToken(channelToken, runId) = "rt_" + sha256(channelToken ":" runId)
 *
 * So there is no table, no mint step and no revocation list - and none of those
 * absences is a shortcut. The channel token is a shared secret the machine agent
 * already holds; deriving from it means possession of a run token proves the
 * holder was handed it by something that held the channel secret AND that it is
 * for exactly one run. The server verifies by recomputing, which is stateless and
 * survives a deploy mid-run - the same property the run id's own derivation has.
 *
 * What bounds it in TIME is not the token but the DIRECTIVE: the verbs refuse
 * unless the run's work order is still `claimed` by a live lease. A finished or
 * abandoned run's token therefore stops working the moment its lease settles,
 * which is a stronger statement than an expiry could make - it tracks the actual
 * work rather than a guess about how long it would take.
 *
 * Pure apart from `node:crypto`. The lookup half lives in `context.ts`, which is
 * the part that touches the database.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The wire prefix. Visibly not a channel token, so a credential that leaks into
 *  a log is recognizable for what it is. */
export const RUN_TOKEN_PREFIX = "rt_";

/**
 * The run's CLI credential. A pure function of the channel secret and the run id,
 * so the machine agent computes it without asking and the server verifies it
 * without storing it.
 *
 * Truncated to 32 hex chars (128 bits). That is far past guessable and keeps the
 * value short enough to sit in an environment variable a person may have to read
 * out of a process listing while debugging.
 */
export function runCliToken(channelToken: string, runId: string): string {
  const digest = createHash("sha256").update(`${channelToken}:${runId}`).digest("hex");
  return `${RUN_TOKEN_PREFIX}${digest.slice(0, 32)}`;
}

/**
 * Verify a presented credential for a claimed run id. Constant-time on the bytes
 * (length first, which is not an interesting leak), and false for anything that
 * is not shaped like one of ours - the same posture `agentTokenMatches` takes.
 */
export function runCliTokenMatches(presented: string | null | undefined, channelToken: string, runId: string): boolean {
  const raw = (presented ?? "").trim();
  const value = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
  if (!value.startsWith(RUN_TOKEN_PREFIX)) return false;
  const expected = runCliToken(channelToken, runId);
  if (value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

/**
 * THE ROLES (captain decision 15a).
 *
 * The captain's stability concern is that an agent handed seven verbs "跑崩" -
 * wanders. So a work order carries ONE role, and a role sees a subset of one to
 * three verbs with a one-line usage each. This is the closed set; the subsets and
 * their prose live in `roles.ts` next to the composer that prints them.
 *
 *   discovery  a scheduled sweep: find the thing, write it down, ask a person
 *   fix        approved work: do it, land it, ask for the merge verdict
 *   watch      a standing question: look, and answer the wait either way
 */
export const RUN_ROLES = ["discovery", "fix", "watch"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

export function isRunRole(v: unknown): v is RunRole {
  return typeof v === "string" && (RUN_ROLES as readonly string[]).includes(v);
}
