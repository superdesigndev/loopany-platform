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
      error: "this agent has an EMPTY repo allowlist, so it acts on nothing - set LOOPANY_AGENT_ALLOWED_REPOS",
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
    return { code: "REPO_NOT_ALLOWED", error: "this agent runs comment-only (LOOPANY_AGENT_COMMENT_ONLY) - it never merges" };
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
        "allowed - set LOOPANY_AGENT_ALLOW_DEFAULT_BRANCH only if you mean it",
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

// ---- the run pre-flight (captain decision 12's deterministic half) ----

/**
 * The name we will NEVER execute, whatever the configuration says.
 *
 * The production Loopany daemon and its CLI are somebody's live scheduled work. An
 * instruction executor that could be pointed at them - by a config typo, by an
 * operator reusing a shell, by anything - could stop, restart or re-register a real
 * fleet. So the refusal is in CODE and not in a document, and it is checked on the
 * resolved basename so a path cannot walk around it.
 */
export const NEVER_EXECUTE = new Set(["loopany", "loopany-agent", "loopany-effects"]);

/** The executor's own name, as the refusal should read it. */
function basename(command: string): string {
  const parts = command.split(/[\\/]/);
  return (parts[parts.length - 1] ?? command).trim().toLowerCase();
}

/**
 * WHAT THIS MACHINE MAY EXECUTE - the pre-flight check that runs before an
 * instruction is spawned, and the reason a work order cannot talk this agent into
 * anything its operator did not configure.
 *
 * Four refusals, each fail-closed:
 *
 *   1. NO EXECUTOR. An agent with no configured executor runs nothing. Absent is
 *      "nothing", never "figure something out".
 *   2. A FORBIDDEN EXECUTOR. See `NEVER_EXECUTE` - a hard floor under the
 *      configuration, not a suggestion.
 *   3. NO RUN ROOT. A run with nowhere safe to work has nowhere to work. The jail is
 *      required, so "I forgot to set it" cannot mean "anywhere on this disk".
 *   4. OUT OF SCOPE. The work order asks for a repository this machine does not
 *      allow a run to be scoped to. Note the direction: the instruction's declared
 *      scope and the machine's list COMPOSE - the run may touch the intersection,
 *      and a declaration cannot widen the machine's boundary any more than the
 *      machine can widen the declaration's. The list consulted is `runRepos`, which
 *      DEFAULTS to the effect allowlist; a machine that sets it separately is saying
 *      "a run may work in this repo" WITHOUT saying "an effect may write to it".
 *
 * All four are `RUN_NOT_PERMITTED`, which is deliberately NOT retryable: a command
 * does not join an allowlist by being asked twice.
 */
export function checkRunPermitted(config: AgentConfig, scope: { repos: string[] }): Refusal | undefined {
  const command = config.run.command?.trim();
  if (!command) {
    return {
      code: "RUN_NOT_PERMITTED",
      error: "this agent has NO instruction executor configured, so it runs nothing - set LOOPANY_AGENT_EXEC_COMMAND",
    };
  }
  if (NEVER_EXECUTE.has(basename(command))) {
    return {
      code: "RUN_NOT_PERMITTED",
      error:
        `"${command}" is on this agent's never-execute list: it drives a live Loopany daemon, ` +
        "and an instruction runner must never be able to touch real scheduled work",
    };
  }
  if (!config.run.root?.trim()) {
    return {
      code: "RUN_NOT_PERMITTED",
      error: "this agent has NO run root, so a run has nowhere safe to work - set LOOPANY_AGENT_RUN_ROOT",
    };
  }
  // The RUN scope list, which defaults to the effect allowlist (`config.ts`): a
  // run may READ a repo this machine permits it to work in, which is not the same
  // permission as commenting on it or merging into it. `checkRepoAllowed` - the
  // effect guard - never looks here.
  const outside = scope.repos.map((r) => r.trim().toLowerCase()).filter((r) => r && !config.runRepos.has(r));
  if (outside.length) {
    const allowed = config.runRepos.size ? [...config.runRepos].sort().join(", ") : "(none)";
    return {
      code: "RUN_NOT_PERMITTED",
      error: `the instruction claims scope over ${outside.join(", ")}, which this agent does not allow (allowlist: ${allowed})`,
    };
  }
  return undefined;
}
