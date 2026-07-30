/**
 * Graph Engineering v1 - THE RUNS BRIDGE: the generic INSTRUCTION work order.
 *
 * This module is PURE (no db, no network, no clock) and it is the whole vocabulary
 * of the channel captain decision 12 makes the DEFAULT path for external effects:
 * "an agent does it from an instruction". A `run-task` directive is not a fix-run,
 * a comment-run or a tweet-run - it is one generic shape (INTENT + CONTEXT + SCOPE)
 * that a machine-side agent executes, and every future outward action rides it
 * unless and until somebody earns a coded accelerator for that action.
 *
 * ── the three parts, and why exactly these three ────────────────────────────
 *
 *   INTENT   WHAT to do, in prose, addressed to an agent. Prose because the
 *            executor is an agent: the moment this becomes a command line, the
 *            channel is a coded path again and every new action needs a new shape.
 *   CONTEXT  the structured facts the intent refers to - the object under work, its
 *            fields, the mirror it tracks, whatever the declaration supplies. The
 *            server resolves these because the server is the only side that can see
 *            the graph; the agent never queries it. Never credentials.
 *   SCOPE    the BOUNDARY: where it may work, what it may touch, how long it has.
 *            This is the half the deterministic pre-flight guard reads, which is
 *            why it is structured while the intent is prose - "did a person approve
 *            this?" and "is this repo in scope?" must be answerable without asking
 *            a model.
 *
 * ── the guard sandwich rides the DIRECTIVE, not the handler (decision 12) ────
 *
 * BEFORE the agent spawns: the R3 human-approval re-check and the scope/allowlist
 * check, both deterministic, both on the machine side where the credentials are
 * (`packages/machine-agent`). AFTER it returns: the observation layer confirming
 * reality - a merge the agent claims it performed is believed because the sensing
 * pipe sees GitHub say so, not because the run said it did. Agent-side idempotency
 * is instruction DISCIPLINE ("check reality before acting", composed into every
 * prompt) with observation as the consistency backstop. That is the invariant that
 * survives whichever executor runs the work, which is exactly why it is attached
 * here and not to any one handler.
 *
 * ── what the server deliberately does NOT decide ────────────────────────────
 *
 * HOW the instruction is executed. Which binary receives it, whether that binary is
 * a coding agent or a bounded script, where its sandbox root is, which repos this
 * machine will act on - all read from the MACHINE'S own environment by the agent,
 * for the same reason the repo allowlist is. This module validates the SHAPE of a
 * declaration and stops there, so a server bug, or a tampered directive row, cannot
 * widen what the far end is willing to run.
 */

/** The event kinds the run lifecycle appends. Named here, next to the spec, so the
 *  Timeline's classifier and the probes read the same two strings the writer does. */
export const RUN_STARTED_EVENT = "run-started";
export const RUN_FINISHED_EVENT = "run-finished";

/**
 * WHAT THE RUN FOUND - the run's own verdict on its own work.
 *
 * An outcome says whether the run WORKED (`success`/`failure`); a FINDING says what
 * it found, and the two are genuinely different questions. A watch that ran
 * perfectly and turned up a regression is a `success` whose result a person has to
 * look at; the identical run on a quiet day is a `success` that should wake nobody.
 * Collapsing them would leave a loop with exactly two report-back paths and no way
 * to say "this needs you" without lying about having failed.
 *
 * Closed on purpose, and small. The vocabulary is what a DECLARATION can bind a
 * transition to (`onFinding` / `onNothingNew`), so every value here must mean the
 * same thing for every type in the registry - richer, run-specific nuance belongs in
 * the report the run writes, which is the thing a person then reads.
 *
 * ABSENT is a real third value and NOT a default of either: an executor that does
 * not speak this contract (or a run that never said) reports no finding at all, and
 * the resolver falls back to the plain `onSuccess` path - which is exactly what
 * every work order did before this existed.
 */
export const RUN_FINDINGS = ["discovery", "nothing-new"] as const;
export type RunFinding = (typeof RUN_FINDINGS)[number];

export function isRunFinding(v: unknown): v is RunFinding {
  return typeof v === "string" && (RUN_FINDINGS as readonly string[]).includes(v);
}

/** The external "system" an instruction targets. It does not act on GitHub or
 *  Linear - it acts through the MACHINE - and `effect_directives.target_source` is
 *  stored rather than implied by kind precisely so a second kind of target needs no
 *  column. */
export const RUN_TARGET_SOURCE = "machine";

/** Default wall clock when a declaration names none. An agent run is not instant;
 *  this is generous enough for a real one and short enough that a declaration which
 *  forgot to think about it fails fast and visibly rather than holding a lease all
 *  afternoon. */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Ceiling on a declared timeout, server side. The AGENT clamps again against its
 *  own maximum - this one only stops a declaration from asking for a week. */
export const MAX_RUN_TIMEOUT_MS = 60 * 60 * 1000;

/** Caps on the prose and the context a work order may carry. A jsonb payload is
 *  read by humans in the workspace and shipped over the wire on every claim; an
 *  instruction that needs a megabyte of context is describing a different problem. */
export const INTENT_CAP = 8_000;
export const CONTEXT_CAP = 32_000;

/**
 * What the instruction may touch. Structured, closed, and deliberately small: every
 * field here is something a DETERMINISTIC check can evaluate before the agent
 * spawns, which is the only kind of guard worth having in front of a model.
 */
export interface RunScope {
  /**
   * Where the work happens. A RELATIVE path is resolved against the agent's own run
   * root; an absolute one must still fall inside it. Either way the agent decides,
   * because the agent is what knows where its sandbox is.
   */
  workdir?: string;
  /**
   * Repositories this instruction is allowed to act on, `owner/name`. The agent
   * INTERSECTS this with its own allowlist and refuses if the declaration asks for
   * anything the machine does not permit - so the two boundaries compose rather
   * than one overriding the other. Empty ⇒ the instruction claims no repo scope,
   * and an agent asked to touch one anyway is out of scope by construction.
   */
  repos: string[];
  /**
   * Paths the instruction may write, relative to the workdir. Carried into the
   * prompt as an explicit boundary AND available to a future filesystem-level
   * check; today it is instruction discipline, which is honest about what it is.
   */
  writes: string[];
  timeoutMs: number;
}

/** One instruction work order, fully resolved. Flat and self-contained: the agent
 *  never queries the graph, so everything it needs is here. */
export interface InstructionSpec {
  /** The run's own id - derived from the directive, so it is stable across
   *  re-claims and re-deliveries (see `runIdOf`). */
  runId: string;
  intent: string;
  context: Record<string, unknown>;
  scope: RunScope;
  /** One line naming the work, for the Timeline and the agent's own log. */
  label: string;
  /** The transition to run on the DISPATCHING object when the run succeeds /
   *  fails. Absent ⇒ the run leaves an event and a report but moves nothing, which
   *  is a legitimate posture for a pure investigation. */
  onSuccess?: string;
  onFailure?: string;
  /**
   * The transition for a SUCCESSFUL run that reported a FINDING (see `RUN_FINDINGS`).
   * This is how a declaration says "and if the run turns something up, do this
   * instead" - the loop spec binds `onFinding` to a transition whose `enqueue-review`
   * action puts the run's report in front of a person.
   *
   * Both fall back to `onSuccess` when absent, so a work order that declares neither
   * behaves exactly as it did before findings existed.
   */
  onFinding?: string;
  onNothingNew?: string;
  /** Should the run's captured output become a report DOC? A run that produces a
   *  page of analysis wants this; one that only acts does not. */
  report: boolean;
}

/**
 * A run's id: `run-<directive id>`.
 *
 * Prefixed rather than hashed on purpose. The directive id is already a pure
 * function of the approving event (`<eventId>-<seq>`), so hashing would buy no
 * extra determinism and would cost the one property worth having here - that a
 * person reading a `run-…` actor id in the Timeline can see, without a lookup,
 * exactly which work order it came from.
 */
export function runIdOf(directiveId: string): string {
  return `run-${directiveId}`;
}

/** The reverse. Returns undefined for anything that is not a run id, so a caller
 *  can only ever act on ids it understands. */
export function directiveIdOfRun(runId: string): string | undefined {
  return runId.startsWith("run-") && runId.length > 4 ? runId.slice(4) : undefined;
}

/** The report DOC a run produces, keyed by the run - so a re-delivered report lands
 *  on the same row instead of minting a twin. */
export function runReportDocId(runId: string): string {
  return `obj-run-${runId.replace(/^run-/, "")}`;
}

/** The external id an instruction work order carries. Not a URL and not a repo: its
 *  "external entity" is the run itself, on the machine. */
export function runTargetExternalId(runId: string): string {
  return `run/${runId}`;
}

export type ParseInstructionResult = { ok: true; spec: InstructionSpec } | { ok: false; why: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Build an instruction work order from a declarative action payload.
 *
 * Payload contract (`dispatch-outward-run`):
 *
 *   intent      REQUIRED prose: what the agent should do
 *   context     structured facts the intent refers to (object, default {})
 *   scope       {workdir?, repos?: string[], writes?: string[], timeoutMs?}
 *   label       one line naming the work (default: the intent's first line)
 *   onSuccess   transition to run on the dispatching object when it succeeds
 *   onFailure   transition to run when it fails
 *   report      true ⇒ the captured output becomes a report DOC
 *
 * Every refusal is a refusal and not a default. A work order with no intent is a
 * broken DECLARATION, and inventing one - or shrugging and marking the action done -
 * would turn a spec bug into either an arbitrary instruction or a silently missing
 * consequence. Dead-lettering it puts it in front of a person, which is the only
 * honest answer.
 */
export function parseInstruction(directiveId: string, payload: unknown): ParseInstructionResult {
  const p = (payload ?? {}) as Record<string, unknown>;
  const intent = str(p.intent);
  if (!intent) {
    return { ok: false, why: "the declaration carries no `intent` - a work order with nothing to do is a spec bug" };
  }
  if (intent.length > INTENT_CAP) {
    return { ok: false, why: `\`intent\` is ${intent.length} characters, over the ${INTENT_CAP} cap` };
  }

  const rawContext = p.context;
  if (rawContext !== undefined && (typeof rawContext !== "object" || rawContext === null || Array.isArray(rawContext))) {
    return { ok: false, why: "`context` must be an object of structured facts" };
  }
  const context = (rawContext ?? {}) as Record<string, unknown>;
  const contextSize = JSON.stringify(context).length;
  if (contextSize > CONTEXT_CAP) {
    return { ok: false, why: `\`context\` serializes to ${contextSize} bytes, over the ${CONTEXT_CAP} cap` };
  }

  const scope = parseScope(p.scope);
  if (!scope.ok) return { ok: false, why: scope.why };

  const onSuccess = str(p.onSuccess);
  const onFailure = str(p.onFailure);
  const onFinding = str(p.onFinding);
  const onNothingNew = str(p.onNothingNew);

  return {
    ok: true,
    spec: {
      runId: runIdOf(directiveId),
      intent,
      context,
      scope: scope.scope,
      label: str(p.label) ?? firstLine(intent),
      ...(onSuccess ? { onSuccess } : {}),
      ...(onFailure ? { onFailure } : {}),
      ...(onFinding ? { onFinding } : {}),
      ...(onNothingNew ? { onNothingNew } : {}),
      report: p.report === true,
    },
  };
}

/**
 * WHICH TRANSITION A REPORT-BACK RUNS - the one place the mapping lives.
 *
 * Pure, and deliberately the whole rule rather than three branches spread over the
 * bridge: a run's outcome and its finding together decide what the dispatching
 * object does next, and a second copy of that decision anywhere would be a place for
 * the two to disagree about what "nothing found" means.
 *
 * A failure never consults the finding. A run that broke has no standing to say what
 * it found - whatever it printed is an account of a run that did not finish - so the
 * failure path is `onFailure` or nothing, exactly as before.
 */
export function outcomeTransition(
  spec: Pick<InstructionSpec, "onSuccess" | "onFailure" | "onFinding" | "onNothingNew">,
  outcome: "success" | "failure",
  finding?: RunFinding | null,
): string | undefined {
  if (outcome === "failure") return spec.onFailure;
  if (finding === "discovery") return spec.onFinding ?? spec.onSuccess;
  if (finding === "nothing-new") return spec.onNothingNew ?? spec.onSuccess;
  return spec.onSuccess;
}

function parseScope(raw: unknown): { ok: true; scope: RunScope } | { ok: false; why: string } {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    return { ok: false, why: "`scope` must be an object" };
  }
  const s = (raw ?? {}) as Record<string, unknown>;
  const workdir = str(s.workdir);
  if (workdir && /[\n\r\0]/.test(workdir)) return { ok: false, why: "`scope.workdir` carries a newline or a NUL" };

  const repos = stringList(s.repos);
  if (repos === undefined) return { ok: false, why: "`scope.repos` must be an array of \"owner/name\" strings" };
  const badRepo = repos.find((r) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r));
  if (badRepo) return { ok: false, why: `\`scope.repos\` entry "${badRepo}" is not "owner/name"` };

  const writes = stringList(s.writes);
  if (writes === undefined) return { ok: false, why: "`scope.writes` must be an array of strings" };

  const rawTimeout = Number(s.timeoutMs);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), MAX_RUN_TIMEOUT_MS)
      : DEFAULT_RUN_TIMEOUT_MS;

  return { ok: true, scope: { ...(workdir ? { workdir } : {}), repos, writes, timeoutMs } };
}

/** A list of non-empty strings, or undefined when the value is not one. `undefined`
 *  input is an empty list (absent scope is no scope, not an error). */
function stringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return undefined;
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Let the DISPATCHING OBJECT supply the scope its static declaration cannot know.
 *
 * A type spec is written once and serves every instance, so it can declare "writes
 * report.md" but not "work in ~/scratch/thing-47 on owner/repo". Those are instance
 * facts, and this is how they reach the work order: the object's own `workdir` and
 * `repos` fields fill the scope fields the declaration LEFT OPEN. A declaration that
 * states them WINS - a spec author who pinned a scope meant to pin it, and an
 * instance must not be able to widen it.
 *
 * Note the direction: this can only fill an absent field, never replace a declared
 * one, and the agent narrows again against its own allowlist afterwards. So the two
 * boundaries compose, and neither an instance nor a server bug can widen what the
 * machine will do.
 */
export function withObjectScope(payload: unknown, objectPayload: Record<string, unknown> | null): unknown {
  const p = (payload ?? {}) as Record<string, unknown>;
  const o = objectPayload ?? {};
  const declared =
    typeof p.scope === "object" && p.scope !== null && !Array.isArray(p.scope)
      ? ({ ...(p.scope as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  if (declared.workdir === undefined && str(o.workdir)) declared.workdir = str(o.workdir);
  if (declared.repos === undefined) {
    const repos = repoList(o.repos);
    if (repos.length) declared.repos = repos;
  }
  return { ...p, scope: declared };
}

/** `["a/b"]` or `"a/b, c/d"` → a list. A comma string is accepted because a task's
 *  plain text field is how a human types one, and refusing it would push the
 *  splitting into every caller. */
function repoList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  const s = str(v);
  return s ? s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * Read an instruction spec back off a DIRECTIVE's stored payload - the inverse of
 * what the handler wrote. Returns undefined when the payload is not one, so a caller
 * holding a non-run directive gets an absence rather than a plausible shape.
 */
export function instructionOf(payload: unknown): InstructionSpec | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const runId = str(p.runId);
  const intent = str(p.intent);
  if (!runId || !intent) return undefined;
  const scope = parseScope(p.scope);
  const onSuccess = str(p.onSuccess);
  const onFailure = str(p.onFailure);
  const onFinding = str(p.onFinding);
  const onNothingNew = str(p.onNothingNew);
  return {
    runId,
    intent,
    context:
      typeof p.context === "object" && p.context !== null && !Array.isArray(p.context)
        ? (p.context as Record<string, unknown>)
        : {},
    scope: scope.ok ? scope.scope : { repos: [], writes: [], timeoutMs: DEFAULT_RUN_TIMEOUT_MS },
    label: str(p.label) ?? firstLine(intent),
    ...(onSuccess ? { onSuccess } : {}),
    ...(onFailure ? { onFailure } : {}),
    ...(onFinding ? { onFinding } : {}),
    ...(onNothingNew ? { onNothingNew } : {}),
    report: p.report === true,
  };
}
