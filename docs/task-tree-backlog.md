# Task tree — backlog

> Companion to `task-tree-plan.md` (which covers the SHIPPED 5 phases on
> `feat/task-tree`). This file is the ideation output: what to build NEXT on top
> of the tree, what was deliberately killed, and why. Last worked: 2026-07-21.

## Where the branch stands

Phases 1–5 are code-complete, typecheck + tests green, merges into `main` with no
conflicts. Nothing is deployed: the branch was never merged, so the skill prose
(`?raw`-bundled) hasn't shipped and there's no `@crewlet/loopany` release carrying
the new CLI grammar. Deprecated aliases stay one more release by design.

Added 2026-07-21 on top of the original 5 phases: `TaskRow.teamId`,
`listTaskScopes()` server fn, `store.listTeams()` (open-mode only), and team/device
pickers on `/tasks` (client-side filtering over the already-scoped payload).

## The thesis

A single loop can only see its own metric, so it optimizes toward theater. The
answer is not a better loop — it's cross-loop judgment, plus contact with
something outside the loop that can't be argued with. The tree's job is to give
that judgment a *referent*: without stated intent, a review can only report
activity; with it, a review can report misalignment.

Prompted by "From Loop Engineering to Graph Engineering?" (Perez, 2026-07-18).
Its real axis is **grounded vs ungrounded**, not loop vs graph — which is why
none of the surviving items below are graph topology.

## Backlog (ordered)

### 1. F6 — active team for the CLI  (re-specced 2026-07-27)

v2 already shipped most of the original ask: `list` is team-wide, `--team <id>` /
`--here` filter, `ownerScopedLoops` is the one resolver, out-of-scope is a flat
404. What remains is the DEFAULT-SCOPE decision, settled 2026-07-27
(validated against a comparable open-source managed-agents platform, which ships
a stored default workspace + `workspace switch`):

1. **Stored default team**: `loopany team use <id>` (membership-validated); reads
   and writes scope to it. Not always-personal, not all-teams-merged.
2. **Agent-facing surfaces embed `--team` explicitly** (run prompts, help hints,
   home view command suggestions): humans get convenient stored state, agents
   never depend on it. This splits the kubectl-style hidden-state risk exactly
   where it belongs.
3. **Every `create`/`update` response echoes the team it landed in**
   (`· team: acme`) — create currently lands in the machine home team
   (or claim-bound team) while list shows everything, which is the confusing
   incoherence this closes. Print the active team in list/get headers too
   (the Slack rule: stored state is fine iff every interaction displays it).

The original credential question (a revocable read-only team key vs the device
token) stays open but is no longer blocking — the device token's owner scope
covers the single-operator case.

### 2. F5 — extend `search` to artifacts  (subsumes F1) — **BUILT 2026-07-27**

`taskSearch` covers title/slug/`taskFileContent` — task files only. Artifacts are
invisible to it. Extending search over artifacts is what makes "has any loop
already flagged this?" answerable, which is the whole point of the findings idea.

With F6, add `--team` for fleet-wide search. **F5 without F6 is a toy.**

Convention that rides along: a finding is a markdown artifact with `type:
finding` in its front matter. Nothing else required — `type` already exists and is
parsed at byte ingress into `blobs.meta`.

Deliberately deferred inside this item: a `subject:` indexed key for exact dedup
(`blobs.meta` is jsonb, so widening needs no migration). Full-text over
title+content should be enough to prove the behavior first.

### 3. F7 — human review queue  (notice + decide only) — **BUILT 2026-07-27**

Runs produce things a human should look at — a Reddit draft, a support reply, a
risky cleanup. Today there is no way to see those across loops, so they're found
by chance or not at all.

Human-in-the-loop needs three parts: **notice** (something is waiting),
**decide** (context + a low-friction verdict), and **effect** (the decision
reaches the machine and the loop acts). **Scoped 2026-07-21 to notice + decide.**

That scope makes this a **worklist, not an approval workflow**: the loop flags an
artifact, you see it in one place, you go do the thing yourself, you clear it.
Genuinely useful alone — triage was the expensive part.

**Do not label the action "Approve."** With no consumer downstream, an Approve
button is a lie that breaks the first time an "approved" draft never gets posted.
Use "Mark reviewed" / "Dismiss" — honest now, and the same record becomes the
decision when effect lands.

v1:
1. Front-matter convention `status: needs-review` (+ optional `due:`) on any
   artifact a run wants eyes on — machine-authored, the file stays source of truth.
2. Cross-loop queue view = F5's aggregation filtered to that status.
3. Dismissal is **server-side view state, never written into the front matter** —
   two writers on one field means the next sync resurrects the item and it reads
   as a bug.
4. Notice: fold the pending count into the push that already fires; add a badge.
   No new channel.

CLI comes free once F6 lands: `loopany search --status needs-review --team`.

Not a new subsystem — F5's aggregation plus a filter, which is the sign the shape
is right.

#### Effect — deferred, but the mechanism is already proven

When it's time: `loops.editRequest` is the precedent for a human→machine channel.
`scheduler/index.ts:148` writes the instruction + arms `nextRunAt`, `:284` picks
the run role from it, `delivery.ts:57` hands it to the machine at claim, `:155`
clears it once spent. An approval is the same shape — set server-side, delivered
at claim, cleared on consumption — just keyed `(loopId, artifactPath)` instead of
single-slot free text. Dispatch lazily (next scheduled run) or eagerly
(`scheduler.runNow`, which the branch already exposes on a machine route) when
latency matters, as with a support reply.

Two things to decide deliberately at that point:
- **Does edited content flow downward?** "Approve" is a flag; "edit then approve"
  means the server stores content destined for the machine — a real inversion of
  the one-way-up sync model (still zero-exec; the server only stores bytes). Ship
  approve/reject first.
- **Decisions go stale.** A support reply approved three days late may be wrong.
  The run must re-verify before acting — is the thread still open, still
  unanswered? An approval is a claim about a world that keeps moving.

Keep the vocabulary at approve / reject+note on ONE artifact. A second approver
or a routing rule means Jira's workflow engine, which the loops do not need.

### 4. F2 — slot arbitration for a shared resource

Re-deferred 2026-07-27: the evidence that tripped the old tripwire was a
DUPLICATE pair (two loops running the same daily repo-health job), and the right fix for duplicates is
"archive one" — fleet hygiene (F3), not arbitration. The per-loop no-stacking
prose already works within each loop; the only real gap is cross-loop
visibility. New tripwire: 3+ DISTINCT, wanted loops opening PRs on one repo in
the same week. Platform shape when it fires: a `resource:` label on the loop
envelope + a server-side dispatch gate over it (the part prose cannot do —
no loop can see another loop's PRs).

Shape: centralized Analyze+Plan, decentralized Monitor+Execute. Domain loops stay
whole (splitting sense from act destroys the investigation context that makes
fixes good) and ask an arbiter for a slot before acting. Replaces five copies of
"no-stacking" prose in the templates with one policy in one place.

### 5. F3 — cross-loop review loop  (agreed: later)

A meta-loop whose subject is the other loops. Reads: each loop's recent run
outcomes, what it *claimed*, what's independently checkable, and the silences.
Outputs: overlap/contention, unverified claims, goal drift, dead loops, frontier.
Ends in **proposals a human accepts or rejects**, where accepting applies the
change.

Relationship to `evolve`: evolve improves a loop *toward* its reference and is
structurally blind to whether that reference is right. Review owns the reference.
Mechanism needs nothing new — review writes a note into each loop's folder; the
next evolve pass reads it.

v1 scope, per the 2026-07-21 discussion: keep the task tree up to date, flag
outdated claims. Not the broader list.

Run it as a **session** first (you, in a coding agent, weekly), not as a loop —
zero new auth surface, and the manual pass is how you spec the real thing.

## Built 2026-07-27 (this branch, uncommitted at time of writing)

- **F5**: `taskSearch` covers markdown artifacts (path/title metadata-free;
  content via bounded blob reads — 400 files / 64KB caps, truncation surfaced).
  CLI renders an `── artifacts` section; `--json` carries the rows.
- **F7**: front-matter `status: needs-review` (+`due`) indexed into `blobs.meta`;
  `review_marks` table (migration 0006) keyed (loop, path, HASH) so dismissals
  re-surface when content changes; `loopany review` / `review clear <task>
  <path>`; web `/review` page ("MARK REVIEWED", never Approve) + `/tasks`
  REVIEW(n) link; the home needs-you rail carries the notice. Push fold-in
  still deferred.
- **Dispatch/assignee matrix rows 4/7/9/11/13-16**: daemon routes `assignee` on
  `@` (email=human, null=clear, else=executor op — fixes the roster-slug bug);
  create rejects non-email assignees with teaching; `editLoop` allows
  field+assignee combos (fields first, op against the NEW state; partial
  failure names the failed part); bare status→todo prints the teaching hint.
  Rule of thumb shipped: "assignment dispatches; status never does."

## Review follow-ups (accepted findings deferred as restructures)

From the 2026-07-27 four-lens cleanup review; each is real but reaches beyond
that day's diff:

- **Extract `applyFields` from `editLoop`** so the combined field+assignee path
  stops re-entering the public verb (re-runs auth/scoping; a future top-of-verb
  guard would silently run twice).
- **Server-side assignee plane-routing**: the daemon's `@` split is a lexical
  guess — a renamed agent containing `@` would mis-route to the human plane.
  Deeper fix: send every `assignee=` to the server; registry-first, email
  fallback, one router.
- **Shared advisory helper over the store's taskMeta diff** so the roster
  warning + dispatch hint cover ALL taskFileContent writers (doc push and
  watcher sync currently skip them).
- **One `actorFor(machine)` helper** — the email-else-userId idiom exists ~6
  times with disagreeing fallbacks.
- **Partial index for the review queue** (`blobs.meta->>'status'`) if queues
  grow past toy size — the scan is currently bounded by LIMIT, not by an index.

## Resolved — no change needed (checked against a comparable platform, 2026-07-27)

- **Assignment is the dispatch edge; `status=todo` does not dispatch.** The
  comparable platform ships the identical model (assign → queued task → daemon claims; status moves
  never dispatch). Status is unsafe as a trigger here anyway: it arrives via
  four channels (explicit verb, doc push, watcher sync of a hand-edited README,
  a run's own close) and only the first is human intent — a file save must
  never spawn a paid run.
- **`create --assignee` stays human-only; agent hand-off is create-then-assign.**
  The comparable is also two-step (`issue create`, then assign). Keeps create atomic
  (no create+rebind+dispatch partial-failure states) and keeps executor
  assignment behind its own deliberate verb (consent fence: assigning execution
  = code running on a machine).

## Killed — do not re-litigate

| Idea | Why it died |
|---|---|
| Typed edges (`watches`/`guards`/`blocks`) | Nothing reads them. Topology for its own sake. `refs[]` already exists if a human wants a link. |
| Exploration ledger as a new store | It's the run log you already have. The gap was lookup-at-decision-time → became F5. |
| Paired-metric invariant (every optimizing loop must declare a counter-metric) | Too rigid; against "dump anything, structure emerges". Survives only as a *question asked during review*, never a required field. |
| Provenance badge (anchored vs self-reported UI) | Wrong artifact. Generalizes to a "source pointer" prose convention — *how would someone else check this?* — since re-runnable commands don't fit SEO/support/experiments. |
| Boards as saved queries | Answered the wrong question. The review output **is** the personal view. |
| Coverage matrix as a primitive | It's a subtree grouped by status. Pre-create untouched cells as `status: idea`. A habit, not a feature. |
| Splitting loops into monitor + action | Destroys investigation context; overlap is asymmetric (action-side contention hurts, signal-side doesn't). Fix the middle — shared findings + arbiter — not the ends. |
| F6 as originally framed ("a run can't read siblings") | Re-specified: the real gap is *no team-scoped read outside the browser*. See item 1. |
| Backfill path for legacy loops | **Dropped 2026-07-21** — not a breaking change. Loops without `taskMeta` render in the trailing "Loops (untyped)" group; the tree fills in as loops are touched. |
