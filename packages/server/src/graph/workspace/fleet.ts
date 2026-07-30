/**
 * Graph Engineering v1 workspace demo - the FLEET, as seed input.
 *
 * This file is DATA only: no database, no clock, no engine. It is the shape of a
 * real workspace (taken from the reference demo's fleet) expressed as the inputs
 * the kernel primitives actually take - loop classes, artifact FILES in the v1
 * artifact format, external pull requests, typed relations, and a history script
 * of transitions.
 *
 * Two things are deliberately NOT here:
 *  - no statuses. Every artifact and every loop reaches its state by running the
 *    `HISTORY` script through `applyTransition`, so the demo's state column is
 *    always the product of real transitions with real diffs and provenance.
 *  - no rendered HTML. Bodies are Markdown with YAML front matter, parsed by
 *    `@loopany/artifact-format` at seed time and rendered (sanitized) at read
 *    time. The stored bytes are the source of truth; HTML is a projection.
 *
 * Every `at:` timestamp is explicit. Transitions never read the clock (design
 * §12 item 8), which is exactly what makes a backdated history seedable at all.
 */
import type { EntranceClass } from "../types.js";

/** The workspace bands the System view lays out as horizontal lanes. */
export const BANDS = ["platform", "engineering", "marketing", "bizops", "monitors"] as const;
export type Band = (typeof BANDS)[number];

export interface LoopSeed {
  /** Stable seed key, used by the history script and the relation list. */
  key: string;
  name: string;
  band: Band;
  /** `sensor` reads the outside world; `loop` does work. Both are Task+cron. */
  kind: "sensor" | "loop";
  /** Null for a planned class - it has no cadence because it never runs. */
  cron: string | null;
  /** Human cadence line ("daily · 06:00"), shown as the node eyebrow. */
  cadence: string;
  /** One-line "what it did lately", shown in the node tooltip. */
  stat: string;
  /** Column position within the band. */
  rank: number;
  /** Vertical nudge for the second row of planned classes. */
  yOffset?: number;
  /** Designed but never armed: stays in `planned`, draws dashed. */
  planned?: boolean;
  createdAt: string;
}

const CREATED = "2026-07-01T09:00:00+08:00";
const CREATED_LATE = "2026-07-20T09:00:00+08:00";

/**
 * The fleet. Ranks and bands reproduce the reference demo's layout; the `stat`
 * lines are the same copy, so the System view reads identically once the data
 * comes from Postgres instead of a static module.
 */
export const LOOPS: LoopSeed[] = [
  // ---- platform: the delivery pipeline itself ----
  { key: "p-sensor", name: "Requests & issues", band: "platform", kind: "sensor", cron: "*/30 * * * *", cadence: "sensor class · intake", stat: "Captain asks + GitHub issues · 3 today", rank: 0, createdAt: CREATED },
  { key: "p-design", name: "Design rounds", band: "platform", kind: "loop", cron: "0 10 * * *", cadence: "loop class · design", stat: "Demo and review iterations · 1 in hand", rank: 1, createdAt: CREATED },
  { key: "p-build", name: "Build & validate", band: "platform", kind: "loop", cron: "0 */4 * * *", cadence: "loop class · delivery", stat: "Review · test · document · 4 PRs today", rank: 2, createdAt: CREATED },
  { key: "p-release", name: "Release train", band: "platform", kind: "loop", cron: "0 18 * * *", cadence: "loop class · release", stat: "Production promoted 3 times", rank: 3, createdAt: CREATED },
  { key: "p-follow", name: "Release follow-through", band: "platform", kind: "loop", cron: null, cadence: "planned · post-release", stat: "Changelog and ship announcements · not yet running", rank: 4, planned: true, createdAt: CREATED_LATE },

  // ---- engineering: the code-health crews ----
  { key: "rd-loop", name: "React Doctor", band: "engineering", kind: "loop", cron: "0 6 * * *", cadence: "daily · 06:00", stat: "Errors 190→188 · fixes worst issue", rank: 0, createdAt: CREATED },
  { key: "hk-loop", name: "Housekeeper", band: "engineering", kind: "loop", cron: "0 7 * * *", cadence: "daily · 07:00", stat: "One proven cleanup per run", rank: 1, createdAt: CREATED },
  { key: "eng-loop", name: "ENG-010 Error Triage", band: "engineering", kind: "loop", cron: "0 9 * * *", cadence: "daily · 09:00", stat: "Root-caused Safari 16.1 regex crash", rank: 2, createdAt: CREATED },

  // ---- marketing: content and outreach ----
  { key: "plib-loop", name: "Prompt-library engine", band: "marketing", kind: "loop", cron: "0 9,13,17 * * *", cadence: "3× daily · 09/13/17", stat: "Builds playbook candidates · 21 runs/week", rank: 0, createdAt: CREATED },
  { key: "li-loop", name: "LinkedIn Repurposer", band: "marketing", kind: "loop", cron: "0 8 */2 * *", cadence: "every 2 days", stat: "Drafts from your videos", rank: 1, createdAt: CREATED },
  { key: "raeo-loop", name: "Reddit Brief (AEO)", band: "marketing", kind: "loop", cron: "0 11 * * *", cadence: "daily · 11:00", stat: "Maintains a hand-written outreach queue", rank: 2, createdAt: CREATED },
  { key: "seo-loop", name: "SEO Daily Engine", band: "marketing", kind: "loop", cron: "0 8 * * 1-5", cadence: "weekdays · 08:00", stat: "Research → write → git → live", rank: 3, createdAt: CREATED },
  { key: "m-vou", name: "Voice-of-user synthesis", band: "marketing", kind: "loop", cron: null, cadence: "planned · synthesis", stat: "Clusters support, Reddit, and X feedback into roadmap input", rank: 0, yOffset: 62, planned: true, createdAt: CREATED_LATE },
  { key: "m-reputation", name: "Reputation assets", band: "marketing", kind: "loop", cron: null, cadence: "planned · reputation", stat: "Testimonials, case studies, and review responses", rank: 2, yOffset: 62, planned: true, createdAt: CREATED_LATE },

  // ---- bizops: the business surface ----
  { key: "sup-loop", name: "Support Inbox Triage", band: "bizops", kind: "sensor", cron: "0 * * * *", cadence: "always on · hourly", stat: "180 wakes/week · auto-replies easy ones", rank: 0, createdAt: CREATED },
  { key: "b-crm", name: "CRM daily run", band: "bizops", kind: "loop", cron: "0 7 * * *", cadence: "daily · 07:00", stat: "2 skips while machine slept", rank: 1, createdAt: CREATED },
  { key: "b-conv", name: "Converter Report", band: "bizops", kind: "loop", cron: "0 8 * * *", cadence: "daily · 08:00", stat: "Record day · +$189 MRR", rank: 2, createdAt: CREATED },
  { key: "b-signup", name: "Signup guard watch", band: "bizops", kind: "loop", cron: "0 10 * * *", cadence: "daily · 10:00", stat: "2 farmer blocks · no collateral", rank: 3, createdAt: CREATED },
  { key: "b-digest", name: "Digest + A/B gate", band: "bizops", kind: "loop", cron: "0 9 * * *", cadence: "daily · 09:00", stat: "Steady-good · no action needed", rank: 4, createdAt: CREATED },
  { key: "b-billing", name: "Billing & churn radar", band: "bizops", kind: "sensor", cron: null, cadence: "planned · revenue health", stat: "Failed payments, renewals, churn alerts, and win-back", rank: 0, yOffset: 62, planned: true, createdAt: CREATED_LATE },
  { key: "b-activation", name: "Activation funnel watch", band: "bizops", kind: "loop", cron: null, cadence: "planned · activation", stat: "Post-signup drop-off and cohort retention", rank: 3, yOffset: 62, planned: true, createdAt: CREATED_LATE },

  // ---- monitors: the quiet always-on band ----
  { key: "mon-scout", name: "Tuesday SEO Scout", band: "monitors", kind: "loop", cron: "0 9 * * 2", cadence: "monitor · weekly Tue", stat: "Feeds the SEO engine", rank: 0, createdAt: CREATED },
  { key: "mon-vis", name: "AI Visibility Check", band: "monitors", kind: "loop", cron: "0 9 * * 1", cadence: "monitor · weekly Mon", stat: "Week 4 · 257 records", rank: 1, createdAt: CREATED },
  { key: "mon-rai", name: "Reddit AI-citation", band: "monitors", kind: "loop", cron: "3 4 * * *", cadence: "monitor · daily 04:03", stat: "7 runs/week", rank: 2, createdAt: CREATED },
  { key: "mon-radar", name: "Content Radar", band: "monitors", kind: "loop", cron: "8 5 * * *", cadence: "monitor · daily 05:08", stat: "7 runs/week · 1 skip", rank: 3, createdAt: CREATED },
  { key: "mon-fact", name: "LLM Fun Fact", band: "monitors", kind: "loop", cron: "0 10 * * *", cadence: "monitor · daily 10:00", stat: "Median turn = 13% of context", rank: 4, createdAt: CREATED },
  { key: "mon-trends", name: "AI Design Trends", band: "monitors", kind: "loop", cron: "0 9 * * *", cadence: "monitor · daily 09:00", stat: "Quiet day · stayed silent", rank: 5, createdAt: CREATED },
  { key: "mon-seowk", name: "SEO/GEO Snapshot", band: "monitors", kind: "loop", cron: "0 9 * * 1", cadence: "monitor · weekly Mon", stat: "Weekly roll-up delivered", rank: 6, createdAt: CREATED },
  { key: "mon-integrations", name: "Integration ecosystem watch", band: "monitors", kind: "loop", cron: null, cadence: "planned · ecosystem", stat: "New agent CLIs and platforms worth supporting", rank: 2, yOffset: 62, planned: true, createdAt: CREATED_LATE },
  { key: "mon-cost", name: "Cost watch", band: "monitors", kind: "loop", cron: null, cadence: "planned · spend", stat: "Cloud and token spend monitoring", rank: 4, yOffset: 62, planned: true, createdAt: CREATED_LATE },
];

// ---- artifacts: real v1 artifact files (YAML front matter + Markdown) ----

export interface ArtifactSeed {
  key: string;
  /** Registry type: `post` | `report` | `playbook`. Must match the file's own
   *  `type:` front-matter field - the seed asserts they agree. */
  type: "post" | "report" | "playbook";
  /** The loop that produced it (a `produces` edge is written from that loop). */
  loop: string;
  /** The artifact FILE, byte for byte as it would sit in the loop folder. */
  file: string;
  /**
   * The review flow a person owes on this content, if any. Present ⇒ the seeder
   * mints a SHEPHERD task keyed `<key>#review` that tracks the doc and carries
   * the obligation; the content itself never moves (decision 8). Absent ⇒ the
   * doc is simply live content with `published: true`.
   */
  review?: "publish" | "decision" | "ship";
}

/** Small helper so each file below reads like the file it is. */
const file = (frontMatter: string, body: string) => `---\n${frontMatter.trim()}\n---\n\n${body.trim()}\n`;

export const ARTIFACTS: ArtifactSeed[] = [
  {
    key: "eng-policy",
    review: "decision",
    type: "report",
    loop: "eng-loop",
    file: file(
      `type: report
title: Old-browser policy · Safari 16.1 regex crash
loop: ENG-010 Error Triage
createdAt: 2026-07-29T09:00:00+08:00
updatedAt: 2026-07-29T09:00:00+08:00
occurrences: 16
users: 3`,
      `The production errors that looked like two separate regressions reduce to one
compatibility boundary: Safari 16.1 cannot parse the regex used by the new matcher.

## What we observed

- 16 occurrences across 3 users in the last 30 days.
- Every affected session reports Safari 16.1 or an embedded WebKit equivalent.
- Modern browsers and Safari 16.4+ remain clean.

## Decision

Either transpile the expression and keep the old-browser promise, or document
Safari 16.4 as the new floor. The smallest code fix is safe, but the policy should
be explicit before we carry compatibility work forward.

> Recommendation: keep 16.1 support through the current quarter, then review usage again.`,
    ),
  },
  {
    key: "plib-1",
    review: "ship",
    type: "playbook",
    loop: "plib-loop",
    file: file(
      `type: playbook
title: Playbook candidate · Agent evaluation rubric
loop: Prompt-library engine
createdAt: 2026-07-29T07:48:00+08:00
updatedAt: 2026-07-29T07:48:00+08:00`,
      `A compact rubric for reviewing agent work without rewarding activity for its own sake.

## Evaluation dimensions

1. **Outcome:** Did the work change the requested state?
2. **Evidence:** Can another person reproduce the claim?
3. **Restraint:** Did the agent avoid unrelated edits and unnecessary ceremony?
4. **Handoff:** Is the remaining state obvious?

## Scoring note

Score each dimension from 0-2. A result cannot pass with a zero in evidence, even
if the implementation appears correct.

The ship gate is blocked pending a decision on whether restraint belongs in the
core score or remains a separate guardrail.`,
    ),
  },
  {
    key: "plib-2",
    review: "ship",
    type: "playbook",
    loop: "plib-loop",
    file: file(
      `type: playbook
title: Playbook candidate · Durable handoff protocol
loop: Prompt-library engine
createdAt: 2026-07-29T13:04:00+08:00
updatedAt: 2026-07-29T13:04:00+08:00`,
      `A handoff should survive context loss, a new operator, and a cold terminal.

## Required handoff

- Name the outcome already achieved.
- Point to the authoritative files and live environment.
- Record verification commands and their results.
- Separate remaining work from optional polish.

## Failure mode

"Almost done" is not durable state. The receiver must be able to distinguish a
missing permission from an unrun test or an unresolved product choice.

This candidate is parked because its completion grammar overlaps the existing run
protocol; review should decide whether to merge or cross-link them.`,
    ),
  },
  {
    key: "linkedin-sidekick",
    review: "publish",
    type: "post",
    loop: "li-loop",
    file: file(
      `type: post
title: Sidekick Paradigm · LinkedIn draft
loop: LinkedIn Repurposer
channel: linkedin
createdAt: 2026-07-29T08:28:00+08:00
updatedAt: 2026-07-29T08:28:00+08:00`,
      `We keep asking whether AI can replace a person. The more useful question is
whether it can become a reliable sidekick.

A sidekick does not own the mission. It watches the edges, handles the repeatable
work, and brings the uncertain moments back to you with context.

## The operating model

- Give the agent a standing responsibility, not a vague goal.
- Make its boundaries visible in the workflow.
- Put every consequential decision in one human inbox.

The result feels less like "autonomy" and more like a small team you can actually
supervise. That is a quieter promise, and a much more useful one.

**Draft close:** The future of agents may look less like replacement and more like
leverage with receipts.`,
    ),
  },
  {
    key: "reddit-50",
    review: "publish",
    type: "post",
    loop: "raeo-loop",
    file: file(
      `type: post
title: Post today · RC-50 for r/ClaudeDesign
loop: Reddit Brief (AEO)
channel: reddit
subreddit: r/ClaudeDesign
createdAt: 2026-07-29T11:00:00+08:00
updatedAt: 2026-07-29T11:00:00+08:00`,
      `A useful way to keep a design agent from drifting is to separate visual direction
from acceptance evidence.

I keep a short context file with audience, tone, and non-negotiable principles.
The task brief then describes only the change. That stops every iteration from
re-litigating the product personality.

## What has worked

- One screenshot at a fixed viewport.
- A short list of semantic checks from the accessibility tree.
- One explicit "what should not change" sentence.

The agent still explores, but the review has a stable frame. It also makes later
rounds much faster because taste is no longer trapped in chat history.`,
    ),
  },
  {
    key: "reddit-48",
    review: "publish",
    type: "post",
    loop: "raeo-loop",
    file: file(
      `type: post
title: Post today · RC-48 for r/LocalLLaMA
loop: Reddit Brief (AEO)
channel: reddit
subreddit: r/LocalLLaMA
createdAt: 2026-07-29T11:00:00+08:00
updatedAt: 2026-07-29T11:00:00+08:00`,
      `For recurring local-agent work, the scheduler is the easy part. The hard part is
preserving an inspectable boundary around execution.

We use a zero-exec control plane: it stores schedules and state, while each user's
own machine runs the model and code. That keeps credentials and repositories on
the machine that already owns them.

## Trade-offs

- The machine must be online for a run to claim work.
- Progress needs a small callback protocol.
- Observability has to distinguish "queued" from "machine asleep".

In return, the server never becomes a remote shell. For small teams, that trust
boundary has mattered more than shaving a few seconds off dispatch.`,
    ),
  },
  {
    key: "reddit-47",
    review: "publish",
    type: "post",
    loop: "raeo-loop",
    file: file(
      `type: post
title: Post today · RC-47 for r/SideProject
loop: Reddit Brief (AEO)
channel: reddit
subreddit: r/SideProject
createdAt: 2026-07-29T11:00:00+08:00
updatedAt: 2026-07-29T11:00:00+08:00`,
      `The first automation I trust is rarely the one that does the most. It is the one
that knows when to stop.

For a side project, I would start with one loop that observes a narrow signal,
produces one artifact, and asks before any irreversible action.

## A practical first loop

1. Check one source on a predictable cadence.
2. Write a dated summary only when something changed.
3. Put publish, merge, or spend decisions behind a human gate.

Once the review burden stays low for a few weeks, expand it. Reliability
compounds; complexity does not.`,
    ),
  },
  {
    key: "seo-run-14",
    type: "report",
    loop: "seo-loop",
    file: file(
      `type: report
title: SEO Daily Engine · Run 14
loop: SEO Daily Engine
createdAt: 2026-07-29T08:21:00+08:00
updatedAt: 2026-07-29T08:21:00+08:00
run: 14`,
      `Run 14 moved the "scheduled coding agents" page from research through publication.

## Shipped

- Added a comparison of local and hosted execution models.
- Rewrote the introduction around governed delegation.
- Linked the machine setup guide from the first decision point.

## Verification

The production URL returned 200, the page appears in the generated sitemap, and
all internal links resolved. No existing headings or canonical metadata changed.

Next run should measure whether the new comparison section earns search
impressions before expanding the topic cluster.`,
    ),
  },
  {
    key: "converter",
    type: "report",
    loop: "b-conv",
    file: file(
      `type: report
title: Daily converter report · +$189 MRR
loop: Converter Report
createdAt: 2026-07-29T08:00:00+08:00
updatedAt: 2026-07-29T08:00:00+08:00
mrrDelta: 189
conversions: 7`,
      `Yesterday set a new daily record: seven paid conversions added $189 in monthly
recurring revenue.

## Movement

| Step | Before | After |
| --- | --- | --- |
| Visitor → signup | 4.8% | 4.8% |
| Signup → paid | 7.1% | 9.4% |

Five of seven conversions started from the template gallery.

## Read

The gain is concentrated in activation, not acquisition. The new template previews
appear to be reducing uncertainty before the first run.

No alert is warranted yet. Hold the experiment for three more days and watch
refund and first-run completion rates.`,
    ),
  },
  {
    key: "visibility",
    type: "report",
    loop: "mon-vis",
    file: file(
      `type: report
title: AI visibility snapshot · Week 4
loop: AI Visibility Check
createdAt: 2026-07-27T09:00:00+08:00
updatedAt: 2026-07-27T09:00:00+08:00
records: 257`,
      `Week four contains 257 answer records across the tracked product and category prompts.

## Signal

- Loopany appeared in 18% of category answers, up from 13%.
- Mentions most often followed queries about local execution and human approval.
- Competitor citations remained more consistent on generic scheduling prompts.

## Opportunity

The strongest owned phrase is "zero-exec control plane". Publish one plain-language
explainer and connect it to the security documentation before broadening prompt
coverage.`,
    ),
  },
  {
    key: "content-radar",
    type: "report",
    loop: "mon-radar",
    file: file(
      `type: report
title: Content radar · Daily scan
loop: Content Radar
createdAt: 2026-07-29T05:08:00+08:00
updatedAt: 2026-07-29T05:08:00+08:00`,
      `The market was quiet overnight. One theme is worth carrying forward: teams are
talking less about autonomous agents and more about review cost.

## Notable movement

- Two launch posts emphasized approval queues over agent count.
- A Hacker News thread framed background agents as a trust problem.
- No meaningful pricing or positioning changes appeared among tracked products.

## Suggested response

Do not manufacture a news post. Add the review-cost language to the next sidekick
essay and keep the daily channel silent.`,
    ),
  },
  {
    key: "geo-snapshot",
    type: "report",
    loop: "mon-seowk",
    file: file(
      `type: report
title: SEO/GEO weekly snapshot
loop: SEO/GEO Snapshot
createdAt: 2026-07-27T09:00:00+08:00
updatedAt: 2026-07-27T09:00:00+08:00`,
      `Search visibility improved modestly while generative-answer citations moved more clearly.

## This week

- Non-brand impressions rose 8% week over week.
- Three pages entered the top 20 for agent scheduling terms.
- Generative citations increased from 34 to 47 across the benchmark set.

## Focus

Keep the current publishing pace. Consolidate the two overlapping scheduler pages
before creating another article, and preserve the terminology that answer engines
are already quoting.`,
    ),
  },
  {
    key: "support-notes",
    type: "playbook",
    loop: "sup-loop",
    file: file(
      `type: playbook
title: Support triage · Silent wake log
loop: Support Inbox Triage
createdAt: 2026-07-29T12:52:00+08:00
updatedAt: 2026-07-29T12:52:00+08:00`,
      `The hourly support sensor has completed 180 wakes this week. Most ended silently
because no new actionable conversation was present.

## Current state

- 0 tickets waiting for human escalation.
- 4 routine questions answered from verified documentation.
- 1 duplicate conversation linked to its existing issue.

## Guardrail check

No credentials, customer PII, or internal debugging output were copied into
artifacts. The next wake will continue from the current source cursor.`,
    ),
  },
];

// ---- pull requests: an external mirror plus the merge review we own ----

export interface PullRequestSeed {
  key: string;
  number: number;
  repo: string;
  title: string;
  /** The observed external state, written straight onto the mirror. */
  observedStatus: "open" | "checks-green" | "merged" | "closed";
  loop: string;
  observedAt: string;
}

export const PULL_REQUESTS: PullRequestSeed[] = [
  { key: "pr-1250", number: 1250, repo: "superdesigndev/loopany-platform", title: "Unpublished-changes dot on Publish", observedStatus: "checks-green", loop: "p-build", observedAt: "2026-07-23T15:10:00+08:00" },
  { key: "pr-1257", number: 1257, repo: "superdesigndev/loopany-platform", title: "Composite the feedback-count bar", observedStatus: "checks-green", loop: "rd-loop", observedAt: "2026-07-29T06:00:00+08:00" },
  { key: "pr-1254", number: 1254, repo: "superdesigndev/loopany-platform", title: "Remove leftover USAGE_EXAMPLE.tsx", observedStatus: "checks-green", loop: "hk-loop", observedAt: "2026-07-29T07:00:00+08:00" },
  // Already merged - the closed verdict in the history script below.
  { key: "pr-1241", number: 1241, repo: "superdesigndev/loopany-platform", title: "Deferred-run inbox for sleeping machines", observedStatus: "merged", loop: "p-build", observedAt: "2026-07-28T17:20:00+08:00" },
];

// ---- typed relations between loop classes ----

export interface RelationSeed {
  kind: "feeds" | "informs";
  from: string;
  to: string;
  label: string;
}

/**
 * `feeds` is the delivery pipeline's forward flow; `informs` is a cross-band
 * relation (drawn dashed). Edge ids are derived from `{team, kind, src, dst}`,
 * so re-seeding is idempotent by construction.
 */
export const RELATIONS: RelationSeed[] = [
  { kind: "feeds", from: "p-sensor", to: "p-design", label: "scoped" },
  { kind: "feeds", from: "p-design", to: "p-build", label: "approved" },
  { kind: "feeds", from: "p-build", to: "p-release", label: "merged" },
  { kind: "feeds", from: "p-release", to: "p-follow", label: "announces" },
  { kind: "informs", from: "eng-loop", to: "p-sensor", label: "files issues" },
  { kind: "informs", from: "sup-loop", to: "p-sensor", label: "escalates bugs" },
  { kind: "informs", from: "mon-scout", to: "seo-loop", label: "informs" },
  { kind: "informs", from: "sup-loop", to: "m-vou", label: "feedback" },
  { kind: "informs", from: "m-vou", to: "p-sensor", label: "roadmap input" },
  { kind: "informs", from: "li-loop", to: "m-reputation", label: "collects proof" },
  { kind: "informs", from: "b-billing", to: "sup-loop", label: "escalates" },
  { kind: "informs", from: "b-signup", to: "b-activation", label: "cohort signal" },
  { kind: "informs", from: "mon-integrations", to: "p-sensor", label: "platform input" },
  { kind: "informs", from: "b-conv", to: "mon-cost", label: "spend context" },
];

// ---- the history script: every state in the demo is the product of these ----

export interface HistoryStep {
  /** ISO instant WITH offset. Passed to `applyTransition` as `now`. */
  at: string;
  /** Seed key of the object (loop key, artifact key, or `<pr>#review`). */
  object: string;
  transition: string;
  entrance: EntranceClass;
  /** Concrete actor for the entrance class: schedule id / run id / user id. */
  actorId: string;
  /** One-line prose for the Timeline. Rides in the event payload, so the feed
   *  is rendered from real event rows and not from a parallel fixture. */
  note?: string;
  /** Field values the transition writes into the object payload (diffed into
   *  the event, which is what makes the seeded history carry real diffs). */
  fields?: Record<string, unknown>;
  /**
   * Leave this step's outbox actions PENDING instead of draining them. Used for
   * today's escalations so the demo shows a non-empty outbox - the actions a
   * real executor has not delivered yet.
   */
  keepPending?: boolean;
}

const run = (id: string) => `run-${id}`;
const sched = (key: string) => `sched-${key}`;

/**
 * Three days of fleet activity. Ordering is chronological; the seeder applies
 * them in array order so every `from` state is the one the previous step left.
 */
export const HISTORY: HistoryStep[] = [
  // ==== Monday 2026-07-27 ====
  { at: "2026-07-27T09:00:00+08:00", object: "mon-vis", transition: "fire", entrance: "clock", actorId: sched("mon-vis") },
  { at: "2026-07-27T09:05:00+08:00", object: "mon-vis", transition: "complete", entrance: "agent-run", actorId: run("vis-w4"), note: "indexed 257 answer records for week 4", fields: { runs: 4, lastOutcome: "new" } },
  { at: "2026-07-27T09:10:00+08:00", object: "mon-seowk", transition: "fire", entrance: "clock", actorId: sched("mon-seowk") },
  { at: "2026-07-27T09:17:00+08:00", object: "mon-seowk", transition: "complete", entrance: "agent-run", actorId: run("geo-w4"), note: "delivered the weekly search and answer-engine roll-up", fields: { runs: 4 } },
  { at: "2026-07-27T08:00:00+08:00", object: "seo-loop", transition: "fire", entrance: "clock", actorId: sched("seo-loop") },
  { at: "2026-07-27T08:40:00+08:00", object: "seo-loop", transition: "complete", entrance: "agent-run", actorId: run("seo-13"), note: "shipped run 13 from research through live publication", fields: { runs: 13 } },

  // ==== Tuesday 2026-07-28 ====
  { at: "2026-07-28T09:00:00+08:00", object: "mon-trends", transition: "fire", entrance: "clock", actorId: sched("mon-trends") },
  { at: "2026-07-28T09:06:00+08:00", object: "mon-trends", transition: "stand-down", entrance: "agent-run", actorId: run("trends-28"), note: "stayed silent after a quiet signal scan", fields: { runs: 8, lastOutcome: "nothing-new" } },
  { at: "2026-07-28T10:00:00+08:00", object: "b-signup", transition: "fire", entrance: "clock", actorId: sched("b-signup") },
  { at: "2026-07-28T10:07:00+08:00", object: "b-signup", transition: "complete", entrance: "agent-run", actorId: run("signup-28"), note: "verified 2 farmer blocks with no collateral damage", fields: { runs: 8 } },

  // The delivery pipeline's one completed verdict: PR #1241 approved and merged.
  { at: "2026-07-28T16:40:00+08:00", object: "pr-1241#review", transition: "submit", entrance: "agent-run", actorId: run("build-1241"), note: "submitted PR #1241 for a merge verdict" },
  { at: "2026-07-28T17:18:00+08:00", object: "pr-1241#review", transition: "approve", entrance: "human", actorId: "u-demo-captain", note: "approved PR #1241 for merge" },
  { at: "2026-07-28T17:20:00+08:00", object: "p-release", transition: "fire", entrance: "clock", actorId: sched("p-release") },
  { at: "2026-07-28T17:26:00+08:00", object: "p-release", transition: "complete", entrance: "agent-run", actorId: run("rel-28"), note: "promoted the third production release of the day", fields: { runs: 3 } },

  // ==== Wednesday 2026-07-29 (today) ====
  { at: "2026-07-29T04:03:00+08:00", object: "mon-rai", transition: "fire", entrance: "clock", actorId: sched("mon-rai") },
  { at: "2026-07-29T04:09:00+08:00", object: "mon-rai", transition: "complete", entrance: "agent-run", actorId: run("rai-29"), note: "observed new citation opportunities", fields: { runs: 7 } },

  { at: "2026-07-29T05:08:00+08:00", object: "mon-radar", transition: "fire", entrance: "clock", actorId: sched("mon-radar") },
  { at: "2026-07-29T05:15:00+08:00", object: "mon-radar", transition: "complete", entrance: "agent-run", actorId: run("radar-29"), note: "completed the daily market scan", fields: { runs: 7 } },

  // React Doctor opens a PR and hands it to the merge gate.
  { at: "2026-07-29T06:00:00+08:00", object: "rd-loop", transition: "fire", entrance: "clock", actorId: sched("rd-loop") },
  { at: "2026-07-29T06:32:00+08:00", object: "pr-1257#review", transition: "submit", entrance: "agent-run", actorId: run("rd-29"), note: "opened PR #1257 and moved errors from 190 to 188", keepPending: true },
  { at: "2026-07-29T06:34:00+08:00", object: "rd-loop", transition: "complete", entrance: "agent-run", actorId: run("rd-29"), fields: { runs: 7, errors: 188 } },

  { at: "2026-07-29T07:00:00+08:00", object: "hk-loop", transition: "fire", entrance: "clock", actorId: sched("hk-loop") },
  { at: "2026-07-29T07:21:00+08:00", object: "pr-1254#review", transition: "submit", entrance: "agent-run", actorId: run("hk-29"), note: "opened PR #1254 after a proven low-risk cleanup", keepPending: true },
  { at: "2026-07-29T07:23:00+08:00", object: "hk-loop", transition: "complete", entrance: "agent-run", actorId: run("hk-29"), fields: { runs: 7 } },

  { at: "2026-07-29T07:00:00+08:00", object: "b-crm", transition: "fire", entrance: "clock", actorId: sched("b-crm") },
  { at: "2026-07-29T07:12:00+08:00", object: "b-crm", transition: "complete", entrance: "agent-run", actorId: run("crm-29"), fields: { runs: 7, skips: 2 } },

  // Prompt library parks its first candidate at the ship gate.
  { at: "2026-07-29T07:40:00+08:00", object: "plib-loop", transition: "fire", entrance: "clock", actorId: sched("plib-loop") },
  { at: "2026-07-29T07:48:00+08:00", object: "plib-1#review", transition: "submit", entrance: "agent-run", actorId: run("plib-29a"), note: "blocked a playbook candidate at its quality gate", keepPending: true },
  { at: "2026-07-29T07:50:00+08:00", object: "plib-loop", transition: "complete", entrance: "agent-run", actorId: run("plib-29a"), fields: { runs: 21 } },

  { at: "2026-07-29T08:00:00+08:00", object: "b-conv", transition: "fire", entrance: "clock", actorId: sched("b-conv") },
  { at: "2026-07-29T08:05:00+08:00", object: "b-conv", transition: "complete", entrance: "agent-run", actorId: run("conv-29"), note: "recorded +$189 MRR and 7 subscriptions", fields: { runs: 5, mrrDelta: 189 } },

  { at: "2026-07-29T08:00:00+08:00", object: "seo-loop", transition: "fire", entrance: "clock", actorId: sched("seo-loop") },
  { at: "2026-07-29T08:22:00+08:00", object: "seo-loop", transition: "complete", entrance: "agent-run", actorId: run("seo-14"), note: "shipped run 14 from research through live publication", fields: { runs: 14 } },

  { at: "2026-07-29T08:20:00+08:00", object: "li-loop", transition: "fire", entrance: "clock", actorId: sched("li-loop") },
  { at: "2026-07-29T08:28:00+08:00", object: "linkedin-sidekick#review", transition: "submit", entrance: "agent-run", actorId: run("li-29"), note: "drafted Sidekick Paradigm for review", keepPending: true },
  { at: "2026-07-29T08:30:00+08:00", object: "li-loop", transition: "complete", entrance: "agent-run", actorId: run("li-29"), fields: { runs: 1 } },

  { at: "2026-07-29T09:00:00+08:00", object: "b-digest", transition: "fire", entrance: "clock", actorId: sched("b-digest") },
  { at: "2026-07-29T09:05:00+08:00", object: "b-digest", transition: "stand-down", entrance: "agent-run", actorId: run("digest-29"), note: "read the A/B gate as steady-good and took no action", fields: { runs: 8, lastOutcome: "nothing-new" } },

  // ENG-010 escalates a policy question - a report, not a PR.
  { at: "2026-07-29T09:00:00+08:00", object: "eng-loop", transition: "fire", entrance: "clock", actorId: sched("eng-loop") },
  { at: "2026-07-29T09:12:00+08:00", object: "eng-policy#review", transition: "submit", entrance: "agent-run", actorId: run("eng-29"), note: "escalated the Safari 16.1 old-browser policy decision", keepPending: true },
  { at: "2026-07-29T09:14:00+08:00", object: "eng-loop", transition: "complete", entrance: "agent-run", actorId: run("eng-29"), fields: { runs: 8 } },

  { at: "2026-07-29T10:00:00+08:00", object: "mon-fact", transition: "fire", entrance: "clock", actorId: sched("mon-fact") },
  { at: "2026-07-29T10:04:00+08:00", object: "mon-fact", transition: "complete", entrance: "agent-run", actorId: run("fact-29"), note: "measured the median turn at 13% of context", fields: { runs: 8 } },

  // Reddit outreach prepares three postable drafts in one pass.
  { at: "2026-07-29T11:00:00+08:00", object: "raeo-loop", transition: "fire", entrance: "clock", actorId: sched("raeo-loop") },
  { at: "2026-07-29T11:06:00+08:00", object: "reddit-50#review", transition: "submit", entrance: "agent-run", actorId: run("raeo-29"), note: "prepared 3 postable drafts, with RC-50 first", keepPending: true },
  { at: "2026-07-29T11:07:00+08:00", object: "reddit-48#review", transition: "submit", entrance: "agent-run", actorId: run("raeo-29"), keepPending: true },
  { at: "2026-07-29T11:08:00+08:00", object: "reddit-47#review", transition: "submit", entrance: "agent-run", actorId: run("raeo-29"), keepPending: true },
  { at: "2026-07-29T11:10:00+08:00", object: "raeo-loop", transition: "complete", entrance: "agent-run", actorId: run("raeo-29"), fields: { runs: 9 } },

  { at: "2026-07-29T12:00:00+08:00", object: "sup-loop", transition: "fire", entrance: "clock", actorId: sched("sup-loop") },
  { at: "2026-07-29T12:54:00+08:00", object: "sup-loop", transition: "stand-down", entrance: "agent-run", actorId: run("sup-29"), note: "closed a quiet wake with no ticket to escalate", fields: { runs: 180, lastOutcome: "nothing-new" } },

  { at: "2026-07-29T13:00:00+08:00", object: "plib-loop", transition: "fire", entrance: "clock", actorId: sched("plib-loop") },
  { at: "2026-07-29T13:04:00+08:00", object: "plib-2#review", transition: "submit", entrance: "agent-run", actorId: run("plib-29b"), note: "parked a second playbook candidate at its ship gate", keepPending: true },
  { at: "2026-07-29T13:06:00+08:00", object: "plib-loop", transition: "complete", entrance: "agent-run", actorId: run("plib-29b"), fields: { runs: 21 } },

  // The oldest thing still waiting on a person: PR #1250, six days at the gate.
  { at: "2026-07-23T15:12:00+08:00", object: "pr-1250#review", transition: "submit", entrance: "agent-run", actorId: run("build-1250"), note: "submitted PR #1250 for a merge verdict", keepPending: true },

  // Loops the demo shows as RUNNING right now end on a `fire` with no completion.
  { at: "2026-07-29T14:00:00+08:00", object: "p-sensor", transition: "fire", entrance: "clock", actorId: sched("p-sensor"), note: "picked up 3 new requests and issues today", fields: { runs: 3 } },
  { at: "2026-07-29T14:02:00+08:00", object: "p-design", transition: "fire", entrance: "clock", actorId: sched("p-design"), note: "started a demo and review iteration", fields: { runs: 1 } },
  { at: "2026-07-29T14:05:00+08:00", object: "p-build", transition: "fire", entrance: "clock", actorId: sched("p-build"), note: "started a review, test, and document pass", fields: { runs: 4 } },
  { at: "2026-07-29T14:08:00+08:00", object: "mon-scout", transition: "fire", entrance: "clock", actorId: sched("mon-scout"), note: "started the weekly scout that feeds the SEO engine", fields: { runs: 1 } },
];
