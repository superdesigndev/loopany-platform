/**
 * EXECUTING ONE WORK ORDER: guards first, then exactly one outward call.
 *
 * The order is the design. Every guard runs BEFORE the call that would change
 * something, and a guard refusal is a typed outcome the server records - so a
 * refused effect surfaces as an attention item with the reason on it, rather than
 * as silence or as an exception in a log nobody reads.
 *
 * ── idempotency, at the far end ─────────────────────────────────────────────
 *
 * The claim is leased, and a lease can expire while an effect is in flight - so
 * the same directive CAN be executed twice, exactly like the outbox's
 * at-least-once boundary one layer up. Both effects are therefore idempotent
 * against the real world rather than against a local record of having run:
 *
 *   github-comment  the body carries `<!-- loopany-effect:<id> -->`. The agent
 *                   reads the PR's comments first and skips if the marker is
 *                   already there. Identity, not "did I run before?".
 *   github-merge    a merged PR is observed as merged and reported as an
 *                   already-done success. GitHub itself is the dedup.
 *
 * Both report `alreadyDone: true` in that case, so the workspace can tell "we did
 * it" from "it was already so" - which matters when reading what a verdict caused.
 */
import type { AgentConfig } from "./config.js";
import type { Gh } from "./gh.js";
import { checkApproval, checkMergeTarget, checkRepo, findMarkedComment } from "./guards.js";
import type { Directive, ExecuteOutcome } from "./types.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export async function executeDirective(
  config: AgentConfig,
  gh: Gh,
  directive: Directive,
): Promise<ExecuteOutcome> {
  // 1. THE APPROVAL. Before anything else, including before deciding whether we
  //    would have been allowed to - an unapproved work order is not a question
  //    about permissions, it is one we refuse to consider.
  const approval = checkApproval(directive);
  if (approval) return { ok: false, ...approval };

  const repo = directive.target.repo ?? repoOf(directive.target.externalId);
  const number = directive.target.number ?? numberOf(directive.target.externalId);
  if (!repo || !number) {
    return { ok: false, code: "TARGET_UNRESOLVED", error: `cannot read a repo and number from "${directive.target.externalId}"` };
  }

  // 2. THE ALLOWLIST. Applies to every kind, comment included: this agent acts on
  //    the repositories its operator named, and on no others.
  const repoRefusal = checkRepo(config, repo);
  if (repoRefusal) return { ok: false, ...repoRefusal };

  let facts;
  try {
    facts = await gh.view(repo, number);
  } catch (err) {
    // A PR we cannot read is not a permanent verdict on its own - a network blip
    // and a deleted PR look the same from here - so this is the retryable code,
    // and the lease budget is what eventually turns repetition into an attention
    // item.
    return { ok: false, code: "AGENT_ERROR", error: `could not read ${repo}#${number}: ${errText(err)}` };
  }

  if (directive.kind === "github-comment") {
    const body = str(directive.payload.body);
    if (!body) return { ok: false, code: "AGENT_ERROR", error: "the work order carries no comment body" };
    const marker = str(directive.payload.marker) ?? "";
    const existing = findMarkedComment(facts.comments, marker);
    if (existing) {
      return {
        ok: true,
        result: {
          url: existing.url || facts.url,
          detail: "the comment for this verdict was already posted - nothing to do",
          alreadyDone: true,
        },
      };
    }
    try {
      const url = await gh.comment(repo, number, body);
      return { ok: true, result: { url: url || facts.url, detail: `commented on ${repo}#${number}` } };
    } catch (err) {
      return { ok: false, code: "AGENT_ERROR", error: `could not comment on ${repo}#${number}: ${errText(err)}` };
    }
  }

  if (directive.kind === "github-merge") {
    if (facts.merged) {
      return {
        ok: true,
        result: { url: facts.url, detail: `${repo}#${number} was already merged`, alreadyDone: true },
      };
    }
    // 3. THE MERGE GUARDS. The allowlist got us here; landing on a DEFAULT branch
    //    needs its own explicit yes, and a PR GitHub will not merge is refused
    //    with that as the reason rather than attempted and reported as an error.
    const refusal = checkMergeTarget(config, {
      baseRefName: facts.baseRefName,
      defaultBranchName: facts.defaultBranchName,
      state: facts.state,
      merged: facts.merged,
      ...(facts.mergeable ? { mergeable: facts.mergeable } : {}),
    });
    if (refusal) return { ok: false, ...refusal };

    const method = str(directive.payload.method) ?? "squash";
    try {
      await gh.merge(repo, number, method);
    } catch (err) {
      return { ok: false, code: "NOT_MERGEABLE", error: `GitHub refused the merge of ${repo}#${number}: ${errText(err)}` };
    }
    return {
      ok: true,
      result: { url: facts.url, detail: `merged ${repo}#${number} into ${facts.baseRefName} (${method})`, method },
    };
  }

  // A kind this build does not implement is refused LOUDLY. There is deliberately
  // no default branch that shrugs and reports success: an effect nobody performed
  // must never be recorded as one that happened.
  return { ok: false, code: "UNSUPPORTED_KIND", error: `this agent does not implement "${directive.kind}"` };
}

function repoOf(externalId: string): string | null {
  const m = /^([^/]+\/[^/]+)\/pull\/\d+$/.exec(externalId);
  return m ? m[1]! : null;
}

function numberOf(externalId: string): number | null {
  const m = /\/pull\/(\d+)$/.exec(externalId);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 600);
}
