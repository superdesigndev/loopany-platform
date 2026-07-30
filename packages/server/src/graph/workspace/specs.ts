/**
 * Graph Engineering v1 workspace demo - the TYPE SPECS the demo fleet runs on.
 *
 * These are ordinary registry types: each declares a parent archetype and a
 * guarded state machine, and each is PROPOSED then ARMED by the seed
 * (`graphStore.proposeTypeVersion` + `armTypeVersion`) exactly like a real type
 * would be. Nothing here is special-cased by the engine - the demo is a proof
 * that the kernel carries a real fleet, so every status it shows moved through
 * `applyTransition` against the EFFECTIVE version resolved from the registry.
 *
 * LIFECYCLE AND GATES ARE TASK-ONLY (captain decision 8). Every state machine
 * below hangs off the `task` archetype, and nothing else has one:
 *
 *  - a LOOP is a Task with `cron` set (design §4). It has no gate of its own:
 *    a loop is never "waiting on you", the work around its PRODUCTS is.
 *  - a DOC is content. One nominal state, no transitions, plain fields -
 *    `published` among them. `applyTransition` refuses it structurally, so
 *    "content does not walk a state machine" cannot be violated by accident.
 *  - a MIRROR is an external fact we observe. Also no transitions.
 *  - so every human verdict lives on a small REVIEW TASK that `tracks` the thing
 *    under review - a pull request, a post, a playbook, a piece of work. One
 *    answer to "where does work live?", not two.
 *
 * ONE REVIEW TYPE, FIVE PRESETS (captain decision 16, "如无必要勿增实体"). This
 * file used to arm five near-identical review types; they differed only in the
 * words on their states, their obligation key and which consequences their
 * approval declared - none of which is a different STATE SHAPE. So there is one
 * `review` type now (`REVIEW_SPEC`) and the differences are instance data
 * (`REVIEW_PRESETS`).
 *
 * DOMAIN-NEUTRAL (captain decision 17). Nothing in this file knows what a pull
 * request is except the `pull-request` mirror type, which is the EARNED sensing
 * accelerator and is explicitly the exception. Every outward consequence a review
 * can declare stands down unless the INSTANCE asks for it, so a Reddit post or an
 * SEO change rides the same type with different fields and no new platform code.
 *
 * Obligation keys are per-OBJECT (`(objectId, key)` is the obligation's
 * identity), and a review task is created per review - so a recurring flow opens
 * a fresh obligation every time, which a key on the long-lived loop or doc could
 * never do.
 */
import type { TypeSpec } from "../types.js";

/** The team every demo row is scoped to. The graph tables key on team id and
 *  hold no FK to `teams`, so the demo is self-contained and never collides with
 *  a real workspace. */
export const DEMO_TEAM_ID = "team-graph-demo";

/** The human whose verdicts the demo records (provenance `entrance: "human"`). */
export const DEMO_USER_ID = "u-demo-captain";

/**
 * A scheduled loop. `planned` is a real state, not a UI flag: a class that has
 * been designed but never armed has no runs and no products, and the System
 * view draws it dashed straight off this status.
 */
export const LOOP_SPEC: TypeSpec = {
  states: ["planned", "idle", "running", "paused", "completed"],
  initialState: "planned",
  // A closed loop (one with a goal) ends its own life when the goal is met -
  // `loopany finish`. That is a real terminal state, so entering it takes the
  // attested "no open obligations, no pending actions" like any other.
  terminalStates: ["completed"],
  transitions: [
    // ARMING AND PAUSING ARE HUMAN ACTS. Stated rather than left unrestricted,
    // because an unrestricted transition admits the CLOCK - and a cadence that
    // could enter `activate` or `pause` would be a schedule that arms or stops the
    // loop instead of running it. Saying so here is also what lets the scheduler
    // resolve a loop's fire transition unambiguously (`schedule/scheduler.ts`
    // `fireTransitionOf`) instead of every arm having to name it.
    { name: "activate", from: ["planned", "paused"], to: "idle", entrance: "human" },
    /**
     * THE CLOCK ENTRANCE. `clock` provenance means the actor id is a schedule id,
     * never a person - the Timeline says so.
     *
     * The fire DISPATCHES the loop's run, as a generic instruction work order down
     * the same directive channel every other outward effect uses (captain decision
     * 12: "an agent does it from an instruction"). The server itself does nothing -
     * it writes the action, the executor writes the directive, a machine agent runs
     * the work with its own credentials, and `graph/agent/runs.ts` reports back and
     * moves this loop through `complete` / `fail`.
     *
     * The dispatch is R3, so it needs a HUMAN approval event - and a schedule
     * cannot ask per fire, which is what a schedule is FOR. The approval is
     * therefore the standing one: the human event that ARMED the cadence
     * (`schedule/arm.ts`), which the scheduler passes as `approvals[0]`. An unarmed
     * loop's fire is refused rather than dispatched, which is the fail-closed
     * answer and is what keeps decision 2 intact under a clock.
     *
     * The STANDING intent is here; the particulars ride the instance
     * (`payload.brief` / `workdir` / `repos`), so one declaration serves every loop.
     *
     * ── FOUR report-back paths, not two ─────────────────────────────────────
     *
     * The work order declares what each kind of report-back does, and "the run
     * found something a person must decide" is one of them (`onFinding` →
     * `escalate`). That is what makes UNATTENDED DISCOVERY reach a human: the
     * clock dispatches, the agent run does the work and prepares the context, and
     * the RUN'S OWN REPORT-BACK opens the review through the `agent-run`/`rule`
     * entrance every review already admits. The clock gains nothing - it still
     * only dispatches - which is the captain's ruling: a periodic human review is
     * always worth an agent gathering the materials first, and a bare
     * clock-created review is the lazy version of the same thing.
     */
    {
      name: "fire",
      from: ["idle"],
      to: "running",
      entrance: "clock",
      actions: [
        {
          kind: "dispatch-outward-run",
          payload: {
            intent: [
              "You are this loop's scheduled run. Carry out the work described in `context.object.brief`.",
              "",
              "Before acting, CHECK REALITY: read the current state of whatever you are about to change and",
              "stop if this run's work has already been done. A schedule can deliver the same instruction twice.",
              "",
              "Stay inside the scope you were given. Do not touch anything outside `scope.workdir`, do not act",
              "on a repository that is not in `scope.repos`, and never copy a credential, token or personal",
              "detail into anything you write or publish.",
              "",
              "Finish by printing a short markdown report of what you found and what you changed. If there was",
              "nothing to do, say so plainly - a clean stop is a real outcome, not a failure.",
            ].join("\n"),
            scope: { writes: ["report.md"] },
            onSuccess: "complete",
            // The run said it turned something up: hand its report to a person.
            onFinding: "escalate",
            // The run said there was nothing new: a clean stop, and the transition
            // that says so out loud rather than reading as ordinary completion.
            onNothingNew: "stand-down",
            onFailure: "fail",
            report: true,
          },
        },
      ],
    },
    // The three plain outcome transitions a run's report drives. `agent-run` is the
    // replayed history's shape (a run reporting for itself); `rule` is the runs
    // bridge's (design: the state change is the engine's declarative consequence of
    // a run finishing, so `graph/agent/runs.ts` enters it as a rule). Both are real
    // and both belong, which is why this is a SET rather than a widening to "any".
    { name: "complete", from: ["running"], to: "idle", entrance: ["agent-run", "rule"] },
    // "Nothing found" is a first-class outcome: a run that manufactured no
    // activity is a clean stop, not a failure.
    { name: "stand-down", from: ["running"], to: "idle", entrance: ["agent-run", "rule"] },
    // A run that reported a failure. Distinct from `stand-down` on purpose: the
    // Timeline must not read a failed run as a quiet one.
    { name: "fail", from: ["running"], to: "idle", entrance: ["agent-run", "rule"] },
    /**
     * THE RUN FOUND SOMETHING A PERSON MUST DECIDE - the fourth outcome.
     *
     * It DECLARES NO ACTION (captain decision 15). Until this unit it carried an
     * `enqueue-review` chain, so the engine turned every discovery into a review
     * on the run's behalf; that is exactly the spec-declared sequencing decision 15
     * moves into the agent. The run now says what it found by CALLING
     * `graph review request --about <its report> --question "…"`, which opens the
     * same gate through the same seam with the run itself as the actor.
     *
     * The transition survives because it is a GUARDRAIL, not a chain: it records
     * that this fire ended in a finding, so a run that reported `discovery` and
     * then never asked anybody anything is VISIBLE in the Timeline as exactly that
     * - an omission surfaced as a debt, which is decision 15(c)'s posture.
     */
    { name: "escalate", from: ["running"], to: "idle", entrance: ["agent-run", "rule"] },
    // A fire the machine never claimed (asleep/offline), superseded by the next
    // one. Neither success nor failure - it is the scheduler's own record.
    { name: "skip", from: ["idle"], to: "idle", entrance: "clock" },
    // A self-improvement pass over the loop's own configuration.
    { name: "evolve", from: ["idle"], to: "idle", entrance: "agent-run" },
    // An owner-requested change, dispatched as one agent pass.
    { name: "edit", from: ["idle"], to: "idle", entrance: "human" },
    { name: "pause", from: ["idle", "running"], to: "paused", entrance: "human" },
    { name: "finish", from: ["idle", "running", "paused"], to: "completed", entrance: "agent-run" },
  ],
  /**
   * The INSTANCE half of everything above.
   *
   * `brief`/`workdir`/`repos` are the scope a static declaration cannot know
   * (`withObjectScope` folds them into the work order). `role` and `workflow` are
   * captain decision 15's own requirement that WORKFLOW INSTRUCTIONS ARE DATA:
   *
   *   role      which verb subset this loop's runs are handed (`roles.ts`). One
   *             to three verbs, never seven - decision 15(a)'s answer to "the
   *             agent wanders".
   *   workflow  what a run of THIS loop should do, in prose, including which
   *             command to reach for when. It lives on the object because the
   *             alternative is a TypeScript string per loop, which is the thing
   *             decision 15 exists to stop.
   */
  fields: {
    band: "string",
    cadence: "string",
    stat: "string",
    runs: "number",
    brief: "string",
    workdir: "string",
    repos: "string",
    role: "string",
    workflow: "string",
  },
};

/**
 * THE STANDARD REVIEW TASK - one type, five presets (captain decision 16).
 *
 * Until this unit the workspace armed FIVE near-identical task types -
 * `merge-review`, `publish-review`, `decision-review`, `ship-review` and
 * `agent-task`. They differed in three ways only: the words on their states, the
 * key of the obligation they opened, and which consequences their approval
 * declared. None of that is a different STATE SHAPE, which is the captain's bar
 * for a new registry type ("如无必要勿增实体"), so they are one type now and their
 * differences are INSTANCE DATA (`REVIEW_PRESETS` below).
 *
 * ── the shape, and why each state exists ────────────────────────────────────
 *
 *   queued           created; nobody has been asked anything yet
 *   awaiting-verdict GATE. A person owes the answer. One key - `verdict` - for
 *                    every preset, so the inbox query, the button resolver and
 *                    the CLI all read one string instead of five.
 *   approved         a person said yes and the consequence is IN-GRAPH or an
 *                    accelerated outward effect. Terminal: the attested close
 *                    (design §12 item 8) applies exactly as it did before.
 *   dispatched       a person said yes and the consequence is WORK AN AGENT DOES.
 *                    NOT terminal and not a gate: nobody owes anything, we are
 *                    waiting on a machine, and the run's own outcome moves it.
 *   done / failed    the run said so. Two states rather than one plus a field,
 *                    because "it worked" and "it broke" lead a person to
 *                    different places.
 *   rejected         a person said no. The verdict is recorded either way.
 *
 * TWO transitions out of the gate rather than one, and that is the only place the
 * presets touch the state machine: `approve` for a consequence that lands here or
 * through an earned accelerator, `dispatch` for one an agent carries out. Both are
 * `human`, both close the same key. Which one a review offers is read off its
 * `preset` field by the UI and the CLI - data, not a type.
 *
 * ── domain neutrality (captain decision 17) ─────────────────────────────────
 *
 * Nothing here knows what a pull request is. `approve` declares four consequences
 * and EVERY ONE of them is gated by a `requires` clause reading this instance's
 * own payload:
 *
 *   update-fields      writes `approveSet` onto the tracked subject - how a doc's
 *                      `published`/`resolved` field flips (decision 8: content has
 *                      no state machine, so its consequence is a field write)
 *   external-comment   the GitHub comment ACCELERATOR, opt-in per instance
 *   external-merge     the GitHub merge ACCELERATOR, opt-in per instance
 *   notify             the in-workspace trace of the decision
 *
 * So a Reddit post, an SEO change and a pull request are the same review with
 * different instance fields, and the two GitHub-shaped actions are permanently
 * what decision 17 demotes them to: earned exceptions that stand down unless an
 * instance explicitly asks for them. A foreign domain adds NO platform code - it
 * carries its consequence as prose in `consequence`, which `dispatch` hands to an
 * agent.
 */
export const REVIEW_TYPE = "review";

/** The ONE obligation key every review opens. Was five keys across five types. */
export const VERDICT_KEY = "verdict";

export const REVIEW_SPEC: TypeSpec = {
  states: ["queued", "awaiting-verdict", "approved", "rejected", "dispatched", "done", "failed"],
  initialState: "queued",
  gateStates: ["awaiting-verdict"],
  terminalStates: ["approved", "rejected", "done", "failed"],
  transitions: [
    {
      name: "submit",
      from: ["queued"],
      to: "awaiting-verdict",
      // The AGENT RUN that produced the thing under review (the ordinary path
      // now that `graph review request` is how a review is born), the engine RULE
      // that noticed content with no reviewer, or a HUMAN opening one from the
      // workspace - which decision 16 makes a real path, since a person acting in
      // the UI goes through the same verb an agent does.
      entrance: ["agent-run", "rule", "human"],
      opens: [{ key: VERDICT_KEY, class: "human-verdict", label: "Your verdict" }],
    },
    {
      name: "approve",
      from: ["awaiting-verdict"],
      to: "approved",
      entrance: "human",
      closes: [VERDICT_KEY],
      actions: [
        // The consequence a person's yes has ON THE SUBJECT, as instance data:
        // `approveSet` is a plain object written onto the tracked object. Absent ⇒
        // the handler cleanly writes nothing (a review can be a decision with no
        // field consequence at all).
        { kind: "update-fields", payload: { via: "tracks", setFrom: "approveSet" } },
        // EARNED ACCELERATOR (decision 17), opt-in per instance. Off by default:
        // most reviews have nothing to comment on.
        {
          kind: "external-comment",
          payload: {
            via: "tracks",
            requires: { field: "commentIntent", equals: true },
            note: "Approved via the Loopany workspace.",
          },
        },
        // EARNED ACCELERATOR, opt-in per instance and guarded again at the agent
        // (repo allowlist + default-branch refusal). Approving a review is not, by
        // itself, an instruction to land code.
        {
          kind: "external-merge",
          payload: { via: "tracks", requires: { field: "mergeIntent", equals: true }, method: "squash" },
        },
        { kind: "notify", payload: { channel: "inbox" } },
      ],
    },
    { name: "reject", from: ["awaiting-verdict"], to: "rejected", entrance: "human", closes: [VERDICT_KEY] },
    /**
     * THE VERDICT THAT SPENDS A MACHINE - a person approving WORK rather than a
     * field write. Dispatching an agent run is an outward effect: it costs money
     * and it can act on the world, so R3 is the honest class and a human approval
     * is structurally required rather than configurable.
     *
     * The intent is the STANDING one (identical for every instance and every
     * domain); the particulars ride the instance - `context.object.brief` for
     * ordinary work, `context.object.consequence` for "carry out what this review
     * was approved FOR". That pair is decision 17's whole mechanism: a Reddit post
     * and an SEO tweak are prose in a field, executed by an agent with
     * machine-side credentials, with no platform code that knows either domain.
     */
    {
      name: "dispatch",
      from: ["awaiting-verdict"],
      to: "dispatched",
      entrance: "human",
      closes: [VERDICT_KEY],
      actions: [
        {
          kind: "dispatch-outward-run",
          payload: {
            intent: [
              "A person approved this piece of work. Carry it out.",
              "",
              "WHAT was approved is in `context.object` - `brief` when this is ordinary work, `consequence`",
              "when it is the thing a review was approved for. Read both; act on whichever is present.",
              "",
              "Before acting, CHECK REALITY: read the current state of whatever you are about to change and",
              "stop if the work has already been done. This instruction may be delivered more than once.",
              "",
              "Stay inside the scope you were given. Do not touch anything outside `scope.workdir`, do not act",
              "on a repository that is not in `scope.repos`, and never copy a credential, token or personal",
              "detail into anything you write or publish.",
              "",
              "Finish by printing a short markdown report of what you found and what you changed. If there was",
              "nothing to do, say so plainly - a clean stop is a real outcome, not a failure.",
            ].join("\n"),
            scope: { writes: ["report.md"] },
            onSuccess: "succeeded",
            onFailure: "broke",
            report: true,
          },
        },
        { kind: "notify", payload: { channel: "inbox" } },
      ],
    },
    // The two outcome transitions. `entrance: "rule"` because the state change is
    // the engine's declarative consequence of a run finishing - the same shape an
    // observation takes when it closes a wait.
    { name: "succeeded", from: ["dispatched"], to: "done", entrance: "rule" },
    { name: "broke", from: ["dispatched"], to: "failed", entrance: "rule" },
  ],
  /**
   * Every difference between the old five types, as INSTANCE FIELDS.
   *
   *   preset        which recipe this review is (`REVIEW_PRESETS`) - a LABEL for
   *                 the UI and the CLI, never something the engine branches on
   *   question      what the person is actually being asked
   *   subject       the object under review (also a `tracks` edge)
   *   approveSet    fields `approve` writes onto the subject
   *   commentIntent opt into the GitHub comment accelerator
   *   mergeIntent   opt into the GitHub merge accelerator
   *   consequence   prose an agent carries out when `dispatch` is the verdict
   *   brief/workdir/repos   the dispatch's own scope
   */
  fields: {
    preset: "string",
    question: "string",
    subject: "string",
    approveSet: "object",
    commentIntent: "boolean",
    mergeIntent: "boolean",
    consequence: "string",
    brief: "string",
    workdir: "string",
    repos: "string",
  },
};

/**
 * THE PRESETS - recipes for a standard review Task, and nothing more.
 *
 * Each is the payload a `review request` starts from plus which gate transition
 * its verdict runs. They are DATA: the engine never reads `preset`, the registry
 * holds one type, and adding a sixth recipe (an SEO change, a Reddit post) is a
 * row here or - better - just different flags on the CLI call.
 */
export interface ReviewPreset {
  /** Which human transition discharges the gate. */
  verdict: "approve" | "dispatch";
  /** The button a person sees. */
  label: string;
  /** Default payload the preset contributes. */
  payload: Record<string, unknown>;
  /** One line for `graph review request --help`. */
  summary: string;
}

export const REVIEW_PRESETS: Record<string, ReviewPreset> = {
  /** Somebody must decide something. The plain default, and the one with no
   *  consequence beyond the decision being recorded. */
  decision: {
    verdict: "approve",
    label: "Your call",
    payload: { approveSet: { resolved: true } },
    summary: "a question only a person can answer (default)",
  },
  /** Content a person releases: approving flips the subject's `published` field. */
  publish: {
    verdict: "approve",
    label: "Review",
    payload: { approveSet: { published: true } },
    summary: "content waiting to be published",
  },
  /** The GitHub merge ACCELERATOR (decision 17: an exception, not the pattern).
   *  Approving comments on the tracked PR mirror and merges it. */
  merge: {
    verdict: "approve",
    label: "Approve",
    payload: { commentIntent: true, mergeIntent: true, approveSet: {} },
    summary: "a pull request the run wants merged (GitHub accelerator)",
  },
  /** Work a MACHINE does once a person says go - any domain, prose in
   *  `consequence`/`brief`, executed by an agent with local credentials. */
  dispatch: {
    verdict: "dispatch",
    label: "Run it",
    payload: {},
    summary: "work an agent should carry out once approved",
  },
};

export const REVIEW_PRESET_NAMES = Object.keys(REVIEW_PRESETS);

/** The transition a preset's verdict runs; unknown presets fall back to the
 *  ordinary approval, so a hand-made review is never un-answerable. */
export function verdictTransitionOfPreset(preset: string | undefined): "approve" | "dispatch" {
  return REVIEW_PRESETS[preset ?? ""]?.verdict ?? "approve";
}

// ---- docs: content, no lifecycle (decision 8) ----

/**
 * The three content types are all the SAME shape now: one nominal state, no
 * transitions, and plain fields. `applyTransition` refuses them structurally
 * (`ARCHETYPE_HAS_NO_STATE_MACHINE`), so "a doc cannot walk a state machine" is
 * a property of the system rather than a rule someone has to remember.
 *
 * `published` is a FIELD. It is written by `graphStore.updateObjectFields` - in
 * practice by the `update-fields` action a shepherd task's approving transition
 * enqueues, so even the field write has an event behind it.
 */
function docSpec(fields: Record<string, unknown>): TypeSpec {
  return {
    states: ["current"],
    initialState: "current",
    transitions: [],
    fields: { published: "boolean", version: "number", ...fields },
  };
}

/** Posts & content: written by a loop, published only by a person. */
export const POST_SPEC: TypeSpec = docSpec({ channel: "string" });

/** Reports & notes: a dated product per run. */
export const REPORT_SPEC: TypeSpec = docSpec({ metric: "string", resolved: "boolean" });

/** Docs: durable playbook material. */
export const PLAYBOOK_SPEC: TypeSpec = docSpec({ merged: "boolean" });

/**
 * The external pull request. A mirror declares NO transitions: its state is the
 * world's, and `applyTransition` refuses to move it (`ARCHETYPE_HAS_NO_STATE_MACHINE`).
 * The seed sets its observed status through `getOrCreateMirror`, which is an
 * UPSERT on the deterministic mirror id - so re-seeding converges on one row.
 */
export const PULL_REQUEST_SPEC: TypeSpec = {
  // `observed` is the honest state for a PR we only ever saw REFERENCED (a run
  // message linking to it): we know it exists, we did not observe whether it
  // merged. Claiming `open` or `merged` there would be inventing an observation.
  states: ["observed", "open", "checks-green", "merged", "closed"],
  initialState: "observed",
  transitions: [],
  fields: { repo: "string", number: "number" },
};

/**
 * Every custom type the demo arms, with its parent archetype.
 *
 * SIX, down from ten (captain decision 16). The four shepherd types and the
 * `agent-task` collapsed into `review`; a mirror registered by the domain-neutral
 * `mirror track` verb uses the BUILT-IN `mirror` archetype base type, so a
 * foreign source needs nothing here either (decision 17).
 */
export const DEMO_TYPES = [
  { name: "loop", archetype: "task", spec: LOOP_SPEC, rationale: "a scheduled agent loop - a Task with cron" },
  {
    name: REVIEW_TYPE,
    archetype: "task",
    spec: REVIEW_SPEC,
    rationale: "the standard review Task - every human verdict, five presets, one state shape (decision 16)",
  },
  { name: "post", archetype: "doc", spec: POST_SPEC, rationale: "outbound content; publishing is a field, not a state" },
  { name: "report", archetype: "doc", spec: REPORT_SPEC, rationale: "a dated run product" },
  { name: "playbook", archetype: "doc", spec: PLAYBOOK_SPEC, rationale: "durable reference content" },
  {
    name: "pull-request",
    archetype: "mirror",
    spec: PULL_REQUEST_SPEC,
    rationale: "an observed GitHub pull request - the EARNED sensing accelerator, not the pattern (decision 17)",
  },
] as const satisfies readonly { name: string; archetype: "task" | "doc" | "mirror"; spec: TypeSpec; rationale: string }[];

/** Type name → the Library category its artifacts group under. */
/**
 * Which Library category a CONTENT object belongs to. Shepherd tasks are NOT
 * here on purpose: the Library lists the artifact, and its shepherd supplies the
 * verdict button rather than occupying a row of its own.
 */
export const CATEGORY_OF_TYPE: Record<string, string> = {
  post: "Posts & content",
  report: "Reports & notes",
  playbook: "Docs",
  "pull-request": "Pull requests",
};

/**
 * The registry type EVERY human verdict lives on, and the one obligation key it
 * opens. Named once so the read model, the UI and the CLI cannot drift from the
 * spec - and, since decision 16, there is exactly one entry where there were five.
 */
export const SHEPHERD_TYPES: Record<string, string> = {
  [REVIEW_TYPE]: VERDICT_KEY,
};

/** The preset whose verdict DISPATCHES a run - the read model's "work awaiting a
 *  go-ahead" filter. A preset, not a type: `review` carries all of them. */
export const WORK_PRESET = "dispatch";

/** Library category display order (mirrors the reference demo). */
export const LIBRARY_CATEGORIES = ["Pull requests", "Posts & content", "Reports & notes", "Docs"] as const;

/**
 * The production front-matter `type` values that mean A PERSON OWES SOMETHING.
 *
 * Real loops encode their own lifecycle here - Support Inbox Triage writes
 * `needs_human`, LinkedIn Repurposer writes `drafted`/`queued`, Housekeeper
 * writes `open` - and `seed-real.ts` turns each one into an open gate obligation.
 *
 * It lives in this shared module because BOTH ends need it and they must not
 * drift: the read-only pull uses it to make sure its per-loop recency cap never
 * discards a waiting item (a truncated archive is fine; a truncated inbox is a
 * lie), and the replay uses it to decide which artifacts open a gate.
 */
export const GATE_FRONT_MATTER_TYPES = new Set([
  "needs_human",
  "needs_followup",
  "escalation",
  "drafted",
  "queued",
  "open",
]);
