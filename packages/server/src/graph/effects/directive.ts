/**
 * Graph Engineering v1 - EFFECT DELIVERY: the pure directive vocabulary.
 *
 * This module is PURE (no db, no network, no clock). It owns the three things
 * that must have exactly one definition on the server side of the wire:
 *
 *   1. WHICH OUTWARD ACTION BECOMES WHICH EFFECT. `external-comment` →
 *      `github-comment`, `external-merge` → `github-merge`. A closed map, so an
 *      R3 kind nobody has taught the agent yet has NO directive shape and
 *      dead-letters at the handler instead of arriving at a machine as something
 *      the agent has to guess about.
 *   2. THE IDEMPOTENCY MARKER. A comment is the one effect GitHub will happily
 *      let you perform twice, so every comment we post carries an invisible
 *      marker derived from the directive id, and the agent looks for it before
 *      posting. The marker is built HERE and shipped in the payload, so the
 *      string the agent searches for and the string the server wrote can never
 *      drift apart.
 *   3. THE COMMENT TEXT. The server authors the prose - including the provenance
 *      line naming the verdict this comment came from - because the server is the
 *      only side that can see the graph. The agent posts bytes it was handed.
 *
 * ── why the agent gets a finished payload ───────────────────────────────────
 *
 * Everything the agent needs is resolved before the directive is written: the
 * repo, the PR number, the exact body, the marker. That is deliberate. The agent
 * runs where the credentials are, and the less it has to interpret, the smaller
 * the surface on which a bug there becomes an action on somebody's repository.
 * Its job is: check the guards, run one command, report. Not: work out what was
 * meant.
 */
import type { ActionKind, EffectKind } from "../types.js";
import { parsePrExternalId, prExternalId, PR_SOURCE, type PrIdentity } from "../sensing/pr.js";

/**
 * Outward action kind → the effect a machine agent performs. PARTIAL on purpose,
 * exactly like the outbox handler registry: an R3 kind absent from this map has
 * no delivery shape, and the handler refuses it rather than inventing one.
 */
export const EFFECT_KIND_OF_ACTION = {
  "external-comment": "github-comment",
  "external-merge": "github-merge",
} as const satisfies Partial<Record<ActionKind, EffectKind>>;

export function effectKindOf(action: string): EffectKind | undefined {
  return (EFFECT_KIND_OF_ACTION as Record<string, EffectKind | undefined>)[action];
}

/**
 * The marker a posted comment carries so a re-execution recognizes its own work.
 *
 * An HTML comment, so a reader never sees it and GitHub never renders it, and
 * keyed by the DIRECTIVE ID - which is the outbox action id, which is a pure
 * function of the verdict event. So the identity of "the comment this decision
 * asked for" is stable across replays, restarts and re-claims, and the agent's
 * check is a substring search rather than a heuristic about who wrote what.
 */
export function directiveMarker(directiveId: string): string {
  return `<!-- loopany-effect:${directiveId} -->`;
}

/** Everything a github effect needs to name its target. */
export interface EffectTarget {
  source: string;
  /** `owner/repo/pull/N` - the mirror's own external id, so a directive and its
   *  mirror name the same thing with the same string. */
  externalId: string;
  repo: string;
  number: number;
}

/**
 * Resolve a mirror row into a github PR target, or explain why not.
 *
 * The refusal cases are the honest ones: a mirror of something that is not a
 * GitHub pull request cannot be commented on or merged by this build, and saying
 * so is better than a best-effort attempt against an id we do not understand.
 */
export function targetOfMirror(mirror: {
  archetype: string;
  externalSource: string | null;
  externalId: string | null;
}): { ok: true; target: EffectTarget } | { ok: false; why: string } {
  if (mirror.archetype !== "mirror") {
    return { ok: false, why: `target is a ${mirror.archetype}, and only a mirror names something outside Loopany` };
  }
  if (mirror.externalSource !== PR_SOURCE) {
    return { ok: false, why: `target's source is "${mirror.externalSource ?? "none"}", and only "${PR_SOURCE}" is deliverable` };
  }
  const id = parsePrExternalId(mirror.externalId);
  if (!id) return { ok: false, why: `"${mirror.externalId ?? ""}" is not a pull-request external id` };
  return { ok: true, target: { source: PR_SOURCE, externalId: prExternalId(id), repo: id.repo, number: id.number } };
}

/** The identity half of a target, for callers that want the PR shape back. */
export function identityOf(target: EffectTarget): PrIdentity {
  return { repo: target.repo, number: target.number };
}

// ---- the comment body ----

export interface CommentProvenance {
  /** The shepherd task whose verdict caused this - what a reader recognizes. */
  reviewTitle?: string | null;
  /** The transition a person ran (`approve`). */
  transition?: string | null;
  /** The approval event id - the row in our log this comment can be traced to. */
  approvalEvent: string;
  /** A caller-supplied line, when a spec wants to say something specific. */
  note?: string | null;
}

/**
 * The comment we post, marker included.
 *
 * It says three things and no more: that a person approved this in Loopany, which
 * verdict it was, and how to find that verdict in our log. No agent voice, no
 * summary of the PR (we did not read it), and no credentials or internal ids
 * beyond the event reference - a comment on a public repository is a published
 * artifact, and the house rule about never copying secrets outward applies here
 * more than anywhere.
 */
export function buildCommentBody(directiveId: string, p: CommentProvenance): string {
  const lines: string[] = [];
  lines.push(p.note?.trim() || "Approved via the Loopany workspace.");
  lines.push("");
  const bits: string[] = [];
  if (p.reviewTitle) bits.push(`review: ${p.reviewTitle}`);
  if (p.transition) bits.push(`verdict: \`${p.transition}\``);
  bits.push(`approval event: \`${p.approvalEvent}\``);
  lines.push(`<sub>${bits.join(" · ")}</sub>`);
  lines.push("");
  lines.push(directiveMarker(directiveId));
  return lines.join("\n");
}

// ---- merge options ----

/** GitHub's three merge strategies. `squash` is the default because it is the one
 *  that keeps a scratch branch's noise out of the base history. */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export function isMergeMethod(v: unknown): v is MergeMethod {
  return typeof v === "string" && (MERGE_METHODS as readonly string[]).includes(v);
}

export function mergeMethodOf(v: unknown): MergeMethod {
  return isMergeMethod(v) ? v : "squash";
}
