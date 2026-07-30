/**
 * THE GUARDS. Pure functions, no I/O, no clock - so every one of them is
 * directly testable and none of them can be "mostly right on the happy path".
 *
 * They run on the AGENT because that is where the credentials are. A guard on the
 * server would check a claim the server itself made; a guard here checks what
 * this machine is actually about to do with its own GitHub login, against a
 * boundary this machine's operator set.
 *
 * Every one FAILS CLOSED and returns a TYPED refusal, never a boolean - the code
 * is what decides whether the resulting attention item offers a retry, and
 * "unknown" must never resolve to "allow".
 */
import type { AgentConfig } from "./config.js";
import type { ApprovalBlock, Directive, RefusalCode } from "./types.js";

export interface Refusal {
  code: RefusalCode;
  error: string;
}

/**
 * THE APPROVAL RE-CHECK - the third and last time this fact is verified.
 *
 * The schema refused an outward action with no approval column; the executor
 * refused one whose approval did not resolve to a HUMAN-entered event. This one
 * checks the evidence that actually arrived over the wire, which is the only one
 * of the three that would catch a tampered payload or a server that silently
 * stopped sending the block. Three checks, three different failure modes - that
 * is the point of doing it again rather than trusting the sender.
 *
 * An ABSENT block is a refusal, not a shrug. A work order that cannot show its
 * approval is exactly the thing that must not be executed.
 */
export function checkApproval(directive: Directive): Refusal | undefined {
  const a: ApprovalBlock | undefined = directive.approval;
  if (!a) {
    return {
      code: "APPROVAL_INVALID",
      error: "the work order carries no approval block - an outward effect is never performed on trust",
    };
  }
  if (a.entrance !== "human") {
    return {
      code: "APPROVAL_INVALID",
      error: `approval ${a.eventId} was entered via "${a.entrance}", not by a human - a rule cannot approve an outward effect`,
    };
  }
  if (!a.actorId.trim()) {
    return { code: "APPROVAL_INVALID", error: `approval ${a.eventId} names no actor - an unattributable approval is none` };
  }
  return undefined;
}

/** The repo allowlist. An UNSET allowlist admits nothing; the refusal says so
 *  explicitly rather than reading as "this particular repo is banned", because
 *  the two are fixed in very different ways. */
export function checkRepo(config: AgentConfig, repo: string | null | undefined): Refusal | undefined {
  const name = (repo ?? "").trim().toLowerCase();
  if (!name) return { code: "TARGET_UNRESOLVED", error: "the work order names no repository" };
  if (!config.allowedRepos.size) {
    return {
      code: "REPO_NOT_ALLOWED",
      error: "this agent has an EMPTY repo allowlist, so it acts on nothing - set LOOPANY_EFFECT_ALLOWED_REPOS",
    };
  }
  if (!config.allowedRepos.has(name)) {
    return {
      code: "REPO_NOT_ALLOWED",
      error: `${name} is not on this agent's allowlist (${[...config.allowedRepos].sort().join(", ")})`,
    };
  }
  return undefined;
}

/** What a merge needs to know about its target before it is allowed to happen. */
export interface MergeSubject {
  /** The branch the PR merges INTO. */
  baseRefName: string;
  /** The repository's default branch, as GitHub reports it. */
  defaultBranchName: string;
  state: string;
  merged: boolean;
  mergeable?: string;
}

/**
 * THE DEFAULT-BRANCH REFUSAL.
 *
 * Being on the allowlist gets a repo as far as "this agent may act here". Landing
 * on its DEFAULT branch needs one more, separate, explicit yes - because that is
 * the irreversible one, and because a demo verifying that merges work should not
 * be one misconfiguration away from putting something on `main`. A scratch base
 * branch passes freely; `main` needs somebody to have written down that they
 * meant it.
 *
 * Comparison is on the branch NAME as GitHub reports it, not on a hard-coded list
 * of likely names - a repo whose default is `trunk` deserves the same protection
 * as one whose default is `main`.
 */
export function checkMergeTarget(config: AgentConfig, subject: MergeSubject): Refusal | undefined {
  if (config.commentOnly) {
    return { code: "REPO_NOT_ALLOWED", error: "this agent runs comment-only (LOOPANY_EFFECT_COMMENT_ONLY) - it never merges" };
  }
  const base = subject.baseRefName.trim();
  const def = subject.defaultBranchName.trim();
  // FAIL CLOSED ON AN UNKNOWN BASE OR DEFAULT. If either is missing - a GraphQL
  // shape change, a partial response, a repo we could not fully read - then we
  // cannot tell whether this merge lands on `main`, and "cannot tell" must never
  // resolve to "go ahead". This is the one branch in the guard where getting it
  // wrong is irreversible, so it is the one that must not be permissive.
  if (!base || !def) {
    return {
      code: "DEFAULT_BRANCH_REFUSED",
      error:
        `could not determine whether this merge targets the default branch ` +
        `(base "${base || "unknown"}", default "${def || "unknown"}") - refusing rather than guessing`,
    };
  }
  if (base === def && !config.allowDefaultBranch) {
    return {
      code: "DEFAULT_BRANCH_REFUSED",
      error:
        `this pull request targets "${base}", the repository's DEFAULT branch, and this agent was not told that is ` +
        "allowed - set LOOPANY_EFFECT_ALLOW_DEFAULT_BRANCH only if you mean it",
    };
  }
  if (subject.state === "CLOSED" && !subject.merged) {
    return { code: "NOT_MERGEABLE", error: "the pull request is closed without having merged" };
  }
  if (subject.mergeable === "CONFLICTING") {
    return { code: "NOT_MERGEABLE", error: "GitHub reports the pull request as conflicting" };
  }
  return undefined;
}

/** Does the fetched PR already carry this directive's marker? That is the
 *  comment effect's idempotency check - identity, not a heuristic about who
 *  wrote what or when. */
export function findMarkedComment(
  comments: { body: string; url: string }[],
  marker: string,
): { body: string; url: string } | undefined {
  if (!marker) return undefined;
  return comments.find((c) => c.body.includes(marker));
}
