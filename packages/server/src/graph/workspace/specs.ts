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
 *  - so every human verdict lives on a small SHEPHERD TASK that `tracks` the
 *    thing under review: `merge-review` around a pull request, and
 *    `publish-review` / `decision-review` / `ship-review` around a doc. One
 *    answer to "where does work live?", not two.
 *
 * Obligation keys are per-OBJECT (`(objectId, key)` is the obligation's
 * identity), and a shepherd is created per review - so a recurring flow opens a
 * fresh obligation every time, which a key on the long-lived loop or doc could
 * never do.
 */
import type { EntranceClass, TypeSpec } from "../types.js";

/**
 * Who may take a review from `queued` into its gate state.
 *
 * TWO entrances, deliberately: the AGENT RUN that produced the content (the
 * ordinary path, and what the seeded history replays), and the engine RULE that
 * noticed content with no reviewer - the `enqueue-review` outbox action, which
 * creates the shepherd and opens its gate with `entrance: "rule"` and the action
 * id as its actor. Leaving it unrestricted would have worked too, and would also
 * have admitted `human` and `clock`, neither of which should ever enter a review
 * gate.
 */
const OPENS_A_REVIEW: readonly EntranceClass[] = ["agent-run", "rule"];

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
    { name: "activate", from: ["planned", "paused"], to: "idle" },
    // The scheduler fires it. `clock` provenance means the actor id is a
    // schedule id, never a person - the Timeline says so.
    { name: "fire", from: ["idle"], to: "running", entrance: "clock" },
    { name: "complete", from: ["running"], to: "idle", entrance: "agent-run" },
    // "Nothing found" is a first-class outcome: a run that manufactured no
    // activity is a clean stop, not a failure.
    { name: "stand-down", from: ["running"], to: "idle", entrance: "agent-run" },
    // A run that reported a failure. Distinct from `stand-down` on purpose: the
    // Timeline must not read a failed run as a quiet one.
    { name: "fail", from: ["running"], to: "idle", entrance: "agent-run" },
    // A fire the machine never claimed (asleep/offline), superseded by the next
    // one. Neither success nor failure - it is the scheduler's own record.
    { name: "skip", from: ["idle"], to: "idle", entrance: "clock" },
    // A self-improvement pass over the loop's own configuration.
    { name: "evolve", from: ["idle"], to: "idle", entrance: "agent-run" },
    // An owner-requested change, dispatched as one agent pass.
    { name: "edit", from: ["idle"], to: "idle", entrance: "human" },
    /**
     * The run handed its products to review - another auditable self-transition,
     * the same shape as `skip`/`evolve`/`edit` (decision 8's clarification).
     *
     * This is the one place a REVIEW IS CREATED BY THE ENGINE rather than by a
     * seeder: its `enqueue-review` action fans out over the loop's `produces`
     * edges and, for every unpublished post with nothing already reviewing it,
     * the executor creates the shepherd task through `applyTransition` (entrance
     * `rule`, actor = the action id). A static spec cannot name instances, so the
     * SELECTOR is the declarative answer - "the posts I make", resolved at
     * execution time. Idempotent twice over: the shepherd's id is derived from
     * `(action, doc)`, and a doc that already has a reviewer is skipped.
     */
    {
      name: "queue-review",
      from: ["idle"],
      to: "idle",
      entrance: "agent-run",
      actions: [
        {
          kind: "enqueue-review",
          payload: {
            queue: "publish",
            review: "publish-review",
            via: "produces",
            select: { type: "post", unpublished: true },
          },
        },
      ],
    },
    /**
     * The run opened pull requests and now WAITS for the world to land them -
     * another auditable self-transition, the same shape as `queue-review`.
     *
     * This is the loop's own house rule made mechanical: a coding loop lands one
     * PR at a time and does not stack a second on an unmerged first, so "is that
     * PR merged yet?" is a real, standing wait. Its `register-watch` action fans
     * out over the loop's `produces` edges and opens an `external-wait`
     * obligation on each pull-request MIRROR it made (design §7: "a Task entering
     * a waiting state registers watch interest on its linked Mirror").
     *
     * Note what it is NOT: a gate. Nobody owes a verdict here - we are waiting on
     * GitHub, and design §12 item 5 is explicit that this is an `external-wait`
     * obligation rather than a gate state. The mirror poller
     * (`graph/sensing/poller.ts`) closes it when it observes the merge, with the
     * observation itself as the closing event.
     */
    {
      name: "watch-prs",
      from: ["idle"],
      to: "idle",
      entrance: "agent-run",
      actions: [
        {
          kind: "register-watch",
          payload: {
            via: "produces",
            select: { type: "pull-request" },
            wait: "merge-wait",
            label: "Waiting for GitHub to show the PR merged",
          },
        },
      ],
    },
    { name: "pause", from: ["idle", "running"], to: "paused" },
    { name: "finish", from: ["idle", "running", "paused"], to: "completed", entrance: "agent-run" },
  ],
  fields: { band: "string", cadence: "string", stat: "string", runs: "number" },
};

/**
 * A shepherd is a small TASK that tracks one piece of content and carries the
 * obligation a person owes on it - the same relationship `merge-review` has with
 * a pull-request mirror. The content does not move; the work around it does.
 *
 * Each shepherd's approving transition declares an `update-fields` action rather
 * than writing the doc itself: the transition records the decision, and the
 * executor applies its consequence to the tracked object. `via: "tracks"` tells
 * the executor to follow this task's `tracks` edge, so a static spec can name an
 * instance-specific target.
 */
const REVIEW_ACTIONS = (set: Record<string, unknown>) => [
  { kind: "update-fields" as const, payload: { via: "tracks", set } },
  { kind: "notify" as const, payload: { channel: "inbox" } },
];

/**
 * The work we own around an external pull request. Separate from the PR mirror
 * on purpose: the mirror is the world's state, this is ours.
 */
export const MERGE_REVIEW_SPEC: TypeSpec = {
  states: ["queued", "awaiting-verdict", "approved", "rejected"],
  initialState: "queued",
  gateStates: ["awaiting-verdict"],
  terminalStates: ["approved", "rejected"],
  transitions: [
    {
      name: "submit",
      from: ["queued"],
      to: "awaiting-verdict",
      // EITHER the agent run that produced the content, OR the engine rule that
      // noticed content with no reviewer (`enqueue-review`). Not a human - a
      // person does not open their own review queue - and not the clock.
      entrance: OPENS_A_REVIEW,
      opens: [{ key: "merge-verdict", class: "human-verdict", label: "Approve the merge" }],
      actions: [
        { kind: "enqueue-review", payload: { queue: "merge" } },
        // TWO INDEPENDENT WAITS, on two objects, from one transition - which is
        // exactly what keyed obligations are for (decision 3). The human owes a
        // verdict on THIS task; the world owes us a merge on the MIRROR this task
        // tracks, and only one of those is a gate. When the tracked object is a
        // doc rather than a mirror (the replayed history's merge reviews) the
        // handler cleanly no-ops - there is nothing external to watch.
        {
          kind: "register-watch",
          payload: { via: "tracks", wait: "merge-wait", label: "Waiting for GitHub to show the PR merged" },
        },
      ],
    },
    /**
     * THE VERDICT THAT REACHES GITHUB.
     *
     * Four declared consequences, and which of them apply is decided per instance
     * at execution time rather than by four variants of this type:
     *
     *  1. `update-fields {merged:true}` - the DOC case. The replayed history's
     *     merge reviews track a playbook, and this is what marks it landed. When
     *     the tracked object is a MIRROR the handler cleanly writes nothing: the
     *     world's `merged` comes from observing GitHub, never from our verdict.
     *  2. `external-comment` (R3) - the DEFAULT outward effect and the low-risk
     *     one. It says a person approved this, and names the verdict event so the
     *     comment can be traced back into our log. It changes nothing.
     *  3. `external-merge` (R3) - guarded twice over. `requires` stands it down
     *     unless THIS review was opened with explicit merge intent, and the agent
     *     that would perform it refuses a repo off its allowlist or a PR aimed at
     *     the repo's default branch. Approving a review is not, by itself, an
     *     instruction to land code.
     *  4. `notify` - the in-workspace trace of the decision.
     *
     * Both R3 actions rest on the approval this very transition IS: a human
     * entered it, so its own event is the approval event, re-resolved and
     * re-checked by the executor before any directive is written and a third time
     * by the agent before anything is posted.
     */
    {
      name: "approve",
      from: ["awaiting-verdict"],
      to: "approved",
      entrance: "human",
      closes: ["merge-verdict"],
      actions: [
        { kind: "update-fields", payload: { via: "tracks", set: { merged: true } } },
        {
          kind: "external-comment",
          payload: { via: "tracks", note: "Approved via the Loopany workspace." },
        },
        {
          kind: "external-merge",
          payload: { via: "tracks", requires: { field: "mergeIntent", equals: true }, method: "squash" },
        },
        { kind: "notify", payload: { channel: "inbox" } },
      ],
    },
    { name: "reject", from: ["awaiting-verdict"], to: "rejected", entrance: "human", closes: ["merge-verdict"] },
  ],
  /** `mergeIntent` is the field the `external-merge` action's `requires` clause
   *  reads. Absent or false ⇒ approving comments and stops there. */
  fields: { repo: "string", number: "number", mergeIntent: "boolean" },
};

/**
 * WORK AN AGENT DOES, once a person says go - the runs bridge's own shepherd.
 *
 * Deliberately GENERIC (captain decision 12, symmetric with decision 4's "generic
 * Task first, specialized types earned"): this is not a fix-review or a
 * reply-review, it is "a person approved an instruction and an agent carried it
 * out". The instruction's prose and its particulars come from the INSTANCE, so the
 * same type carries an investigation today and an Intercom reply tomorrow without a
 * new state machine.
 *
 * ── the shape, and why each state exists ────────────────────────────────────
 *
 *   queued            created, nobody asked for anything yet
 *   awaiting-dispatch GATE. A person owes the verdict, because dispatching an agent
 *                     run is an outward effect: it spends money and it can act on
 *                     the world. R3 is the honest class, so a human approval is
 *                     structurally required rather than configurable.
 *   dispatched         the work order is out. NOT terminal, and not a gate either:
 *                     nobody owes anything, we are waiting on a machine. The run's
 *                     own outcome is what moves it, through `applyTransition` with
 *                     `entrance: "rule"` (`graph/agent/runs.ts`).
 *   done / failed      the run said so. Two states rather than one plus a field,
 *                     because "it worked" and "it broke" lead to different next
 *                     actions and the Timeline must not read them the same.
 *   declined           the person said no. The verdict is recorded either way.
 *
 * `approve` declares the dispatch and a notification. Both rest on the approval
 * this very transition IS: a human entered it, so its own event is the approval
 * event, re-resolved by the executor before the work order is written and re-checked
 * a THIRD time by the agent before anything is executed.
 *
 * A run that dies without reporting does NOT strand this task silently: the
 * directive's lease expires, the channel gives up after a bounded number of
 * abandoned claims, and the failed directive becomes an attention item naming this
 * object. The task stays visibly `dispatched` with a reason next to it, which is the
 * honest state - it really is still waiting, and now a person knows why.
 */
export const AGENT_TASK_SPEC: TypeSpec = {
  states: ["queued", "awaiting-dispatch", "dispatched", "done", "failed", "declined"],
  initialState: "queued",
  gateStates: ["awaiting-dispatch"],
  terminalStates: ["done", "failed", "declined"],
  transitions: [
    {
      name: "submit",
      from: ["queued"],
      to: "awaiting-dispatch",
      entrance: OPENS_A_REVIEW,
      opens: [{ key: "dispatch-verdict", class: "human-verdict", label: "Approve the run" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "dispatch" } }],
    },
    {
      name: "approve",
      from: ["awaiting-dispatch"],
      to: "dispatched",
      entrance: "human",
      closes: ["dispatch-verdict"],
      actions: [
        {
          kind: "dispatch-outward-run",
          payload: {
            // The STANDING intent for this type of work. Instance particulars ride
            // in `context.object`, which the handler merges from the task's own
            // payload - so one static declaration serves every instance.
            intent: [
              "Carry out the work described in `context.object.brief`.",
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
    { name: "decline", from: ["awaiting-dispatch"], to: "declined", entrance: "human", closes: ["dispatch-verdict"] },
    // The two outcome transitions. `entrance: "rule"` because the state change is
    // the engine's declarative consequence of a run finishing - the same shape an
    // observation takes when it closes a wait. Restricted to `rule`, so nothing
    // else can claim a run's outcome on its behalf.
    { name: "succeeded", from: ["dispatched"], to: "done", entrance: "rule" },
    { name: "broke", from: ["dispatched"], to: "failed", entrance: "rule" },
  ],
  /** `brief` is the instance's own instruction - what this particular run should do.
   *  `workdir`/`repos` narrow the scope the dispatch declares. */
  fields: { brief: "string", workdir: "string", repos: "string" },
};

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

// ---- shepherd tasks: where a doc's human verdict actually lives ----

/** Posts & content awaiting a human publish decision. */
export const PUBLISH_REVIEW_SPEC: TypeSpec = {
  states: ["queued", "awaiting-publish", "published", "withdrawn"],
  initialState: "queued",
  gateStates: ["awaiting-publish"],
  terminalStates: ["published", "withdrawn"],
  transitions: [
    {
      name: "ready",
      from: ["queued"],
      to: "awaiting-publish",
      // EITHER the agent run that produced the content, OR the engine rule that
      // noticed content with no reviewer (`enqueue-review`). Not a human - a
      // person does not open their own review queue - and not the clock.
      entrance: OPENS_A_REVIEW,
      opens: [{ key: "publish-verdict", class: "human-verdict", label: "Review and publish" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "publish" } }],
    },
    {
      name: "publish",
      from: ["awaiting-publish"],
      to: "published",
      entrance: "human",
      closes: ["publish-verdict"],
      actions: REVIEW_ACTIONS({ published: true }),
    },
    { name: "withdraw", from: ["awaiting-publish"], to: "withdrawn", entrance: "human", closes: ["publish-verdict"] },
  ],
};

/** A report that reached a question only a person can answer. */
export const DECISION_REVIEW_SPEC: TypeSpec = {
  states: ["queued", "awaiting-decision", "decided", "dropped"],
  initialState: "queued",
  gateStates: ["awaiting-decision"],
  terminalStates: ["decided", "dropped"],
  transitions: [
    {
      name: "raise",
      from: ["queued"],
      to: "awaiting-decision",
      // EITHER the agent run that produced the content, OR the engine rule that
      // noticed content with no reviewer (`enqueue-review`). Not a human - a
      // person does not open their own review queue - and not the clock.
      entrance: OPENS_A_REVIEW,
      opens: [{ key: "policy-verdict", class: "human-verdict", label: "Your call on the policy" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "decision" } }],
    },
    {
      name: "decide",
      from: ["awaiting-decision"],
      to: "decided",
      entrance: "human",
      closes: ["policy-verdict"],
      actions: REVIEW_ACTIONS({ resolved: true }),
    },
    { name: "drop", from: ["awaiting-decision"], to: "dropped", entrance: "human", closes: ["policy-verdict"] },
  ],
};

/** Durable playbook material a loop proposes and a person ships. */
export const SHIP_REVIEW_SPEC: TypeSpec = {
  states: ["queued", "awaiting-review", "shipped", "revising"],
  initialState: "queued",
  gateStates: ["awaiting-review"],
  terminalStates: ["shipped"],
  transitions: [
    {
      name: "propose",
      from: ["queued"],
      to: "awaiting-review",
      // EITHER the agent run that produced the content, OR the engine rule that
      // noticed content with no reviewer (`enqueue-review`). Not a human - a
      // person does not open their own review queue - and not the clock.
      entrance: OPENS_A_REVIEW,
      opens: [{ key: "ship-verdict", class: "human-verdict", label: "Review the candidate" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "ship" } }],
    },
    {
      name: "approve",
      from: ["awaiting-review"],
      to: "shipped",
      entrance: "human",
      closes: ["ship-verdict"],
      actions: REVIEW_ACTIONS({ published: true }),
    },
    { name: "revise", from: ["awaiting-review"], to: "revising", entrance: "human", closes: ["ship-verdict"] },
  ],
};

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

/** Every custom type the demo arms, with its parent archetype. */
export const DEMO_TYPES = [
  { name: "loop", archetype: "task", spec: LOOP_SPEC, rationale: "a scheduled agent loop - a Task with cron" },
  { name: "merge-review", archetype: "task", spec: MERGE_REVIEW_SPEC, rationale: "our-side work around an external PR" },
  { name: "post", archetype: "doc", spec: POST_SPEC, rationale: "outbound content; publishing is a field, not a state" },
  { name: "report", archetype: "doc", spec: REPORT_SPEC, rationale: "a dated run product" },
  { name: "playbook", archetype: "doc", spec: PLAYBOOK_SPEC, rationale: "durable reference content" },
  {
    name: "agent-task",
    archetype: "task",
    spec: AGENT_TASK_SPEC,
    rationale: "work an agent does from an approved instruction - the generic outward-effect path (decision 12)",
  },
  { name: "publish-review", archetype: "task", spec: PUBLISH_REVIEW_SPEC, rationale: "the human publish decision on a post" },
  { name: "decision-review", archetype: "task", spec: DECISION_REVIEW_SPEC, rationale: "the human call a report escalated" },
  { name: "ship-review", archetype: "task", spec: SHIP_REVIEW_SPEC, rationale: "the human ship decision on a playbook" },
  { name: "pull-request", archetype: "mirror", spec: PULL_REQUEST_SPEC, rationale: "an observed GitHub pull request" },
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

/** Shepherd task type → the obligation key it opens. One place, so the read
 *  model can find a content object's reviewer without guessing. */
export const SHEPHERD_TYPES: Record<string, string> = {
  "merge-review": "merge-verdict",
  "publish-review": "publish-verdict",
  "decision-review": "policy-verdict",
  "ship-review": "ship-verdict",
};

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
