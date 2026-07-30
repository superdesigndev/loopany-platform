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
import { runInstruction, type RunDeps, type RunOutcomeDetail } from "./run.js";
import { instructionOf, type Directive, type ExecuteOutcome, type RunOutcome } from "./types.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * The two calls a RUN makes back to the graph while it happens, injected so the
 * executor stays a pure "guards then one effect" function and every probe can watch
 * the lifecycle without a server.
 */
export interface RunReporter {
  started: (directive: Directive) => Promise<void>;
  finished: (
    directive: Directive,
    outcome: RunOutcome,
    detail: { summary?: string; exitCode: number | null; durationMs: number; report?: string },
  ) => Promise<void>;
}

export interface ExecuteDeps {
  gh: Gh;
  /** Present only on a machine that executes instructions. */
  run?: RunDeps;
  runReporter?: RunReporter;
}

export async function executeDirective(
  config: AgentConfig,
  deps: ExecuteDeps,
  directive: Directive,
): Promise<ExecuteOutcome> {
  // 1. THE APPROVAL. Before anything else, including before deciding whether we
  //    would have been allowed to - an unapproved work order is not a question
  //    about permissions, it is one we refuse to consider. This is the first half of
  //    the guard sandwich captain decision 12 attaches to the DIRECTIVE rather than
  //    to any one handler, so it runs for a run exactly as it does for a merge.
  const approval = checkApproval(directive);
  if (approval) return { ok: false, ...approval };

  // 2. THE GENERIC PATH FIRST. An instruction work order is the default shape for an
  //    external effect (decision 12); the GitHub branches below are earned
  //    accelerators for two hot actions, not the required road.
  if (directive.kind === "run-task") return executeRun(config, deps, directive);

  const gh = deps.gh;
  const repo = directive.target.repo ?? repoOf(directive.target.externalId);
  const number = directive.target.number ?? numberOf(directive.target.externalId);
  if (!repo || !number) {
    return { ok: false, code: "TARGET_UNRESOLVED", error: `cannot read a repo and number from "${directive.target.externalId}"` };
  }

  // 3. THE ALLOWLIST. Applies to every GitHub kind, comment included: this agent acts
  //    on the repositories its operator named, and on no others.
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

/**
 * Execute an INSTRUCTION work order - the generic "an agent does X" path.
 *
 * The lifecycle is reported around the work rather than after it, and that ordering
 * is the point: `run-started` lands BEFORE the executor spawns, so a run that dies
 * without ever reporting still left a trace of having begun. The outcome report then
 * lands whichever way the run went, so `run-finished` is not a success-only path -
 * a failed run advances the dispatching task through its own declared transition, and
 * the directive's typed refusal raises the attention item.
 *
 * A reporting failure does NOT swallow the run's outcome: the report is best-effort
 * and logged, and the directive report that follows (in `agent.ts`) is what the lease
 * hangs on. If both fail the lease expires and the work order is re-offered, which is
 * safe because the instruction told the agent to check reality first.
 */
async function executeRun(config: AgentConfig, deps: ExecuteDeps, directive: Directive): Promise<ExecuteOutcome> {
  const spec = instructionOf(directive.payload);
  if (!spec) {
    return { ok: false, code: "TARGET_UNRESOLVED", error: "the work order carries no instruction (no intent)" };
  }
  if (!deps.run) {
    return {
      ok: false,
      code: "RUN_NOT_PERMITTED",
      error: "this agent is not configured to execute instructions",
    };
  }

  await report(() => deps.runReporter?.started(directive));

  const outcome: RunOutcomeDetail = await runInstruction(config, spec, deps.run);
  const summary = firstMeaningfulLine(outcome.output) ?? outcome.refusal?.error;

  await report(() =>
    deps.runReporter?.finished(directive, outcome.ok ? "success" : "failure", {
      ...(summary ? { summary } : {}),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      // The run's own output IS the product, when the work order asked for one. A
      // refused run has no output to report, so no empty report doc is created.
      ...(spec.report && outcome.output.trim() ? { report: reportBody(outcome) } : {}),
    }),
  );

  if (!outcome.ok) {
    const refusal = outcome.refusal ?? { code: "AGENT_ERROR" as const, error: "the run failed without a reason" };
    return { ok: false, code: refusal.code, error: refusal.error };
  }
  return {
    ok: true,
    result: {
      url: spec.runId,
      detail: summary
        ? `${spec.label} — ${summary}`
        : `${spec.label} — finished in ${Math.round(outcome.durationMs / 1000)}s`,
      runId: spec.runId,
      durationMs: outcome.durationMs,
      ...(outcome.truncated ? { outputTruncated: true } : {}),
    },
  };
}

/** The report body, with the truncation stated IN it. A clipped report that did not
 *  say it was clipped would read as a complete account of the work. */
function reportBody(outcome: RunOutcomeDetail): string {
  const body = outcome.output.trimEnd();
  return outcome.truncated
    ? `${body}\n\n---\n\n_Output truncated at this agent's capture limit; the run itself was not._\n`
    : body;
}

/** The first line worth showing in a Timeline row: skips blank lines and markdown
 *  heading markers, so a report that opens with `# Title` summarises as the title. */
function firstMeaningfulLine(output: string): string | undefined {
  for (const raw of output.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.slice(0, 300);
  }
  return undefined;
}

/** Lifecycle reporting is best-effort by design - see `executeRun`. */
async function report(call: () => Promise<void> | undefined): Promise<void> {
  try {
    await call();
  } catch {
    // Swallowed here and surfaced by the caller's own logging: a failed lifecycle
    // report must not turn a run that WORKED into a run that failed.
  }
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
