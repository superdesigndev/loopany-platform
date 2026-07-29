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
 * Three shapes recur, and they are the whole point of the demo:
 *
 *  - a LOOP is a Task with `cron` set (design §4). It has no gate of its own:
 *    a loop is never "waiting on you", its PRODUCTS are.
 *  - every artifact type has exactly one GATE STATE. A gate state's outgoing
 *    transition is `entrance: "human"` by construction (design §12 item 5), so
 *    the demo's "Needs you" list cannot be discharged by anything but a person.
 *  - a pull request is a MIRROR: an external fact we observe. It declares NO
 *    transitions, so `applyTransition` refuses it structurally. The work we own
 *    is the separate `merge-review` Task that tracks it.
 *
 * Obligation keys are per-OBJECT (`(objectId, key)` is the obligation's
 * identity), which is why every gate hangs off the artifact and never off the
 * recurring loop: a loop-level key could only ever be opened once in the
 * object's whole life.
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
    { name: "pause", from: ["idle", "running"], to: "paused" },
    { name: "finish", from: ["idle", "running", "paused"], to: "completed", entrance: "agent-run" },
  ],
  fields: { band: "string", cadence: "string", stat: "string", runs: "number" },
};

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
      entrance: "agent-run",
      opens: [{ key: "merge-verdict", class: "human-verdict", label: "Approve the merge" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "merge" } }],
    },
    {
      name: "approve",
      from: ["awaiting-verdict"],
      to: "approved",
      entrance: "human",
      closes: ["merge-verdict"],
      actions: [{ kind: "notify", payload: { channel: "inbox" } }],
    },
    { name: "reject", from: ["awaiting-verdict"], to: "rejected", entrance: "human", closes: ["merge-verdict"] },
  ],
  fields: { repo: "string", number: "number" },
};

/** Posts & content: written by a loop, published only by a person. */
export const POST_SPEC: TypeSpec = {
  states: ["draft", "awaiting-publish", "published", "archived"],
  initialState: "draft",
  gateStates: ["awaiting-publish"],
  terminalStates: ["archived"],
  transitions: [
    {
      name: "draft-ready",
      from: ["draft"],
      to: "awaiting-publish",
      entrance: "agent-run",
      opens: [{ key: "publish-verdict", class: "human-verdict", label: "Review and publish" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "publish" } }],
    },
    {
      name: "publish",
      from: ["awaiting-publish"],
      to: "published",
      entrance: "human",
      closes: ["publish-verdict"],
      actions: [{ kind: "notify", payload: { channel: "inbox" } }],
    },
    { name: "revise", from: ["awaiting-publish", "published"], to: "draft", entrance: "human", closes: ["publish-verdict"] },
    { name: "archive", from: ["*"], to: "archived", entrance: "human" },
  ],
  fields: { channel: "string" },
};

/** Reports & notes: a dated product per run, with an escalation path when the
 *  report reaches a question only a person can answer. */
export const REPORT_SPEC: TypeSpec = {
  states: ["drafting", "complete", "decision-needed", "archived"],
  initialState: "drafting",
  gateStates: ["decision-needed"],
  terminalStates: ["archived"],
  transitions: [
    { name: "complete", from: ["drafting"], to: "complete", entrance: "agent-run" },
    {
      name: "escalate",
      from: ["drafting", "complete"],
      to: "decision-needed",
      entrance: "agent-run",
      opens: [{ key: "policy-verdict", class: "human-verdict", label: "Your call on the policy" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "decision" } }],
    },
    {
      name: "decide",
      from: ["decision-needed"],
      to: "complete",
      entrance: "human",
      closes: ["policy-verdict"],
      actions: [{ kind: "notify", payload: { channel: "inbox" } }],
    },
    { name: "archive", from: ["*"], to: "archived", entrance: "human" },
  ],
  fields: { metric: "string" },
};

/** Docs: durable playbook material a loop proposes and a person ships. */
export const PLAYBOOK_SPEC: TypeSpec = {
  states: ["draft", "ship-blocked", "shipped", "archived"],
  initialState: "draft",
  gateStates: ["ship-blocked"],
  terminalStates: ["archived"],
  transitions: [
    { name: "ship", from: ["draft"], to: "shipped", entrance: "agent-run" },
    {
      name: "block",
      from: ["draft"],
      to: "ship-blocked",
      entrance: "agent-run",
      opens: [{ key: "ship-verdict", class: "human-verdict", label: "Review the candidate" }],
      actions: [{ kind: "enqueue-review", payload: { queue: "ship" } }],
    },
    {
      name: "approve",
      from: ["ship-blocked"],
      to: "shipped",
      entrance: "human",
      closes: ["ship-verdict"],
      actions: [{ kind: "notify", payload: { channel: "inbox" } }],
    },
    { name: "revise", from: ["ship-blocked"], to: "draft", entrance: "human", closes: ["ship-verdict"] },
    { name: "archive", from: ["*"], to: "archived", entrance: "human" },
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
  { name: "post", archetype: "doc", spec: POST_SPEC, rationale: "outbound content with a human publish gate" },
  { name: "report", archetype: "doc", spec: REPORT_SPEC, rationale: "a dated run product with an escalation path" },
  { name: "playbook", archetype: "doc", spec: PLAYBOOK_SPEC, rationale: "durable docs with a human ship gate" },
  { name: "pull-request", archetype: "mirror", spec: PULL_REQUEST_SPEC, rationale: "an observed GitHub pull request" },
] as const satisfies readonly { name: string; archetype: "task" | "doc" | "mirror"; spec: TypeSpec; rationale: string }[];

/** Type name → the Library category its artifacts group under. */
export const CATEGORY_OF_TYPE: Record<string, string> = {
  "merge-review": "Pull requests",
  post: "Posts & content",
  report: "Reports & notes",
  playbook: "Docs",
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
