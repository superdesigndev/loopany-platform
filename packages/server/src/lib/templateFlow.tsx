import type { ReactNode } from 'react'

/**
 * Per-template FLOW SPECS — the one place a template says how it actually runs.
 *
 * Pure data (plus the small pure derivations below), deliberately split out of
 * `components/LoopFlow.tsx` so BOTH consumers read the same source and cannot drift:
 *   • the compose modal's animated preview (`LoopFlow`) — the vertical cycle + the
 *     dashboard widgets it leaves behind;
 *   • the public template detail's static diagram (`TemplateFlowDiagram`,
 *     `/templates/<slug>`) — trigger -> steps -> outputs, SSR-rendered.
 *
 * A template with no spec here simply gets neither surface (the modal falls back to
 * its single-column snippet, the detail page omits the diagram) — better an absent
 * diagram than an invented one.
 */

// `setup` = a one-time gate shown ABOVE the tick, outside the recurring cycle
// (confirm/smoke-test something before the first run). `wt` = runs in the worktree.
// `finish` = a closed loop's green terminus (it finishes itself when the goal is met).
export type NodeDef = { id: string; kicker: string; glyph: string; title: string; detail: ReactNode; wt?: boolean; setup?: boolean; finish?: boolean }

/** A PR card: [number, title, when]. */
export type Card = [string, string, string]
export type Widget =
  | { type: 'kanban'; heading: string; sub?: string; columns: [string, Card[]][] }
  | { type: 'metric'; label: string; series: number[]; note?: string; betterDown?: boolean }
  | { type: 'embed'; heading: string; title: string; date: string; lines: string[] }
  // A compact month grid of report days — mirrors <loop-calendar> (LoopCalendar.tsx).
  // `firstWeekday` is the Monday-start offset (0=Mon…6=Sun) of day 1; `reportDays`
  // are the day-of-month numbers that carry a report.
  | { type: 'calendar'; heading: string; monthLabel: string; days: number; firstWeekday: number; reportDays: number[] }

export type FlowSpec = { worktreeLabel: string; nodes: NodeDef[]; dashboard: Widget[] }

const REACT_DOCTOR: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 6am', detail: 'the loop wakes on cadence' },
    { id: 'scan', kicker: 'Step 1 · Scan', glyph: '⌕', title: 'Scan the app', detail: <code>npx react-doctor@latest</code> },
    { id: 'prio', kicker: 'Step 2 · Prioritise', glyph: '⚖', title: 'Pick one issue', detail: 'the worst, by severity & perf impact' },
    { id: 'fix', wt: true, kicker: 'Step 3 · Fix', glyph: '✎', title: 'Fix in isolation', detail: 'smallest change, fresh branch' },
    { id: 'verify', wt: true, kicker: 'Step 4 · Verify', glyph: '▷', title: 'Verify the fix', detail: 'prove it holds before proposing' },
    { id: 'ship', wt: true, kicker: 'Step 5 · Ship', glyph: '⑂', title: 'Open a PR', detail: "skip if a prior PR's still open" },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'PR board',
      sub: 'open → merged',
      columns: [
        ['Open', [
          ['#231', 'Key-less list items in <Feed/>', 'opened 6h ago'],
          ['#219', 'Missing memo on heavy list row', 'opened 1d ago'],
        ]],
        ['Merged', [
          ['#212', 'Effect re-runs on every render', 'merged 2d ago'],
          ['#205', 'Unmemoised context value', 'merged 4d ago'],
          ['#198', 'Inline object prop churn', 'merged 6d ago'],
        ]],
      ],
    },
    { type: 'metric', label: 'Health score', series: [66, 68, 67, 71, 72, 71, 75, 77, 76, 79, 81, 80, 83, 84] },
  ],
}

const DOCS_SWEEP: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every Mon · 6am', detail: 'weekly · picks up where it left off' },
    { id: 'diff', kicker: 'Step 1 · Compare', glyph: '⌕', title: 'Diff since last sweep', detail: 'docs vs. what the code ships now' },
    { id: 'verify', kicker: 'Step 2 · Verify', glyph: '▷', title: 'Verify for real', detail: 'run the commands, links & examples' },
    { id: 'fix', wt: true, kicker: 'Step 3 · Fix', glyph: '✎', title: 'Fix real drift only', detail: 'never rewrite accurate docs' },
    { id: 'ship', wt: true, kicker: 'Step 4 · Ship', glyph: '⑂', title: 'Open a PR', detail: 'explains the drift · no stacking' },
  ],
  dashboard: [
    {
      type: 'embed',
      heading: 'Latest sweep summary',
      title: 'Docs drift — weekly sweep',
      date: '2026-07-06',
      lines: [
        '3 items fixed, each verified by running it',
        'README — dev server is :3001, not :3000',
        'Setup guide — dropped a dead /api/v1 link',
        'Quickstart — refreshed `loopany new` flags',
      ],
    },
    { type: 'metric', label: 'Drift count', series: [6, 4, 5, 3, 2, 3, 1, 2, 1, 0], note: '0 = docs are honest — a clean stop, no PR.', betterDown: true },
  ],
}

const ERROR_SWEEP: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify an error source', detail: 'smoke-test logs / tracker / gh · confirm window' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 6am', detail: 'sweeps the agreed window' },
    { id: 'sweep', kicker: 'Step 1 · Sweep', glyph: '⌕', title: 'Group into incidents', detail: 'cluster repeated symptoms' },
    { id: 'triage', kicker: 'Step 2 · Triage', glyph: '⚖', title: 'Actionable vs. noise', detail: 'drop upstream & noise' },
    { id: 'fix', wt: true, kicker: 'Step 3 · Fix', glyph: '✎', title: 'Root-cause & fix', detail: 'smallest verified fix' },
    { id: 'ship', wt: true, kicker: 'Step 4 · Ship', glyph: '⑂', title: 'One PR per fix', detail: 'no stacking · never leak secrets' },
  ],
  dashboard: [
    {
      type: 'embed',
      heading: 'Newest report',
      title: 'Error sweep — daily',
      date: '2026-07-08',
      lines: [
        '2 actionable, 14 noise filtered out',
        'Checkout 500 — null cart on retry (fixed)',
        '/api/render timeout — upstream, watching',
        'No credentials or PII in this report',
      ],
    },
    { type: 'metric', label: 'Actionable errors', series: [5, 3, 4, 2, 3, 1, 2, 1, 0, 1], note: '0 actionable = a clean stop, no PR.', betterDown: true },
  ],
}

const HOUSEKEEPER: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 7am', detail: 'one cleanup a day, no more' },
    { id: 'survey', kicker: 'Step 1 · Survey', glyph: '⌕', title: 'Find housekeeping debt', detail: 'dead code, stale files, dupes, unused deps' },
    { id: 'prove', kicker: 'Step 2 · Prove', glyph: '⚖', title: 'Pick one, prove it safe', detail: 'concrete evidence · uncertain → deferred' },
    { id: 'fix', wt: true, kicker: 'Step 3 · Fix', glyph: '✎', title: 'Smallest change', detail: 'keep only if build & tests stay green' },
    { id: 'ship', wt: true, kicker: 'Step 4 · Ship', glyph: '⑂', title: 'Open a PR', detail: 'no stacking on an open PR' },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'Cleanup board',
      sub: 'open → merged',
      columns: [
        ['Open', [
          ['#142', 'Remove dead export in utils/date', 'opened 5h ago'],
          ['#138', 'Drop unused dep left-pad', 'opened 2d ago'],
        ]],
        ['Merged', [
          ['#131', 'Delete stale scripts/legacy dir', 'merged 1d ago'],
          ['#124', 'Dedupe two clamp() helpers', 'merged 3d ago'],
          ['#119', 'Rename inconsistent isLoading flags', 'merged 5d ago'],
        ]],
      ],
    },
    { type: 'metric', label: 'Cleanups landed', series: [0, 1, 1, 2, 3, 3, 4, 5, 6, 6, 7, 9, 10, 12] },
  ],
}

const DEPENDENCY_TRIAGE: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Confirm merge authority', detail: 'smoke-test gh sees Dependabot/Renovate · agree merge policy' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every Mon', detail: 'weekly · snapshots the open PRs' },
    { id: 'snapshot', kicker: 'Step 1 · Snapshot', glyph: '⌕', title: 'List open dep PRs', detail: 'process each exactly once' },
    { id: 'judge', kicker: 'Step 2 · Judge', glyph: '⚖', title: 'Weigh real evidence', detail: 'diff · release notes · advisories · CI at head' },
    { id: 'test', wt: true, kicker: 'Step 3 · Test', glyph: '▷', title: 'Run tests in isolation', detail: 'at the exact head · checkout untouched' },
    { id: 'merge', wt: true, kicker: 'Step 4 · Merge', glyph: '⑂', title: 'Merge only what’s authorized', detail: 'major/breaking/security → recommend, don’t merge' },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'Dependency PRs',
      sub: 'merged · deferred · blocked',
      columns: [
        ['Merged', [
          ['#412', 'bump vite 7.0→7.1 (patch)', 'merged 1h ago'],
          ['#408', 'bump @types/node 20→20.14 (minor)', 'merged 3h ago'],
        ]],
        ['Deferred', [
          ['#399', 'react 18→19 (major) — review', 'deferred 2d ago'],
          ['#391', 'drizzle-orm 0.30→0.31 — CI red', 'deferred 2d ago'],
        ]],
        ['Blocked', [
          ['#405', 'lodash advisory GHSA-…-qxrp (high)', 'flagged 1h ago'],
        ]],
      ],
    },
    { type: 'metric', label: 'Open dependency PRs', series: [9, 8, 8, 6, 7, 5, 4, 3, 4, 2], note: 'trends down as PRs are merged or resolved.', betterDown: true },
  ],
}

const MARKET_RESEARCH: FlowSpec = {
  worktreeLabel: '', // no worktree — this template never touches code (no `wt` nodes)
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Confirm the research focus', detail: 'infer the product & space · propose a focus, confirm' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 5am', detail: 'the loop wakes on cadence' },
    { id: 'research', kicker: 'Step 1 · Research', glyph: '⌕', title: "Scan today's market", detail: 'competitors, launches, pricing, ecosystem news' },
    { id: 'report', kicker: 'Step 2 · Report', glyph: '✎', title: 'One dated report', detail: <code>type: report · title · date</code> },
    { id: 'sharpen', kicker: 'Step 3 · Sharpen', glyph: '✧', title: 'Sharpen the focus', detail: 'lean into what keeps turning out to matter' },
  ],
  dashboard: [
    { type: 'calendar', heading: 'Reports calendar', monthLabel: 'July 2026', days: 31, firstWeekday: 2, reportDays: [1, 2, 3, 6, 7, 8] },
    {
      type: 'embed',
      heading: 'Newest report',
      title: 'Market watch — daily digest',
      date: '2026-07-08',
      lines: [
        "Today's signal: two rivals converged on usage-based pricing",
        'Northwind shipped an AI triage add-on, free in beta',
        'Acme cut its Team tier 20% and dropped the seat minimum',
        'Ecosystem: a new OSS connector spec is gaining traction',
      ],
    },
  ],
}

const FOLLOW_UP: FlowSpec = {
  worktreeLabel: '', // no worktree — it observes, it doesn't fix
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify + define the finish', detail: 'smoke-test an observation path · set the finish condition' },
    { id: 'tick', kicker: 'On cadence', glyph: '◷', title: 'A few times a day', detail: 'wakes on cadence — no fixed clock time' },
    { id: 'observe', kicker: 'Step 1 · Observe', glyph: '⌕', title: 'Check the outcome', detail: 'through the verified path — logs / URL / gh' },
    { id: 'report', kicker: 'Step 2 · Report', glyph: '◈', title: 'Report what you find', detail: 'one report · a metric when natural' },
    { id: 'check', kicker: 'Step 3 · Check', glyph: '⚖', title: 'Goal met?', detail: 'keep watching until it genuinely holds' },
    { id: 'finish', finish: true, kicker: 'When met', glyph: '⚑', title: 'Finish the loop', detail: 'marks it done — stops watching' },
  ],
  dashboard: [
    {
      type: 'embed',
      heading: 'Latest observation',
      title: 'Checkout fix — follow-up',
      date: '2026-07-08',
      lines: [
        'conversion 29% → 44% over 3 days',
        'no error spikes since the deploy',
        'goal: hold ≥ 40% for 48h — 31h in, on track',
      ],
    },
    { type: 'metric', label: 'Checkout conversion %', series: [29, 31, 30, 34, 37, 39, 41, 43, 44], note: 'goal: hold ≥ 40% for 48h, then the loop finishes itself.' },
  ],
}

const SUPPORT_TRIAGE: FlowSpec = {
  worktreeLabel: 'Fix agent · isolated worktree',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Connect inbox + stack', detail: 'smoke-test support read/write · DB, billing, analytics skills · agree the reply boundary' },
    { id: 'tick', kicker: 'Always on', glyph: '◷', title: 'Hourly · gated', detail: 'wakes only on real customer messages — bot noise is a silent tick' },
    { id: 'investigate', kicker: 'Step 1 · Investigate', glyph: '⌕', title: 'Root-cause first', detail: 'their account in DB / billing / sessions — before any reply' },
    { id: 'resolve', kicker: 'Step 2 · Resolve', glyph: '✉', title: 'Reply or escalate', detail: 'vetted answers sent · money & sensitive drafted, held for you' },
    { id: 'capture', kicker: 'Step 3 · Capture', glyph: '⚑', title: 'File the signal', detail: 'ticket note · recurring themes gain frequency' },
    { id: 'fix', wt: true, kicker: 'Step 4 · Fix', glyph: '⑂', title: 'Fix real bugs', detail: 'root-cause → verified PR — never merges' },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'Ticket board',
      sub: 'needs human → resolved',
      columns: [
        ['Needs human', [
          ['SUP-78', 'Forgot-to-cancel refund ask', 'decision drafted'],
          ['SUP-77', 'Unrecognized recurring charge', 'decision drafted'],
        ]],
        ['Resolved', [
          ['SUP-71', '"Canvas blank" — bug fixed, shipped', 'closed warm'],
          ['SUP-69', 'Stuck generation — credits explained', 'auto-replied'],
          ['SUP-66', 'Crash on translate — how-to sent', 'auto-replied'],
        ]],
      ],
    },
    { type: 'metric', label: 'Auto-handled per run', series: [2, 4, 3, 6, 5, 7, 6, 9, 8, 10], note: 'signals & eng bugs accrue on their own boards.' },
  ],
}

const REDDIT_KARMA: FlowSpec = {
  worktreeLabel: '', // no worktree — it comments, it never touches code
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Content library + Reddit CLI', detail: 'confirm the KB · verify opencli login' },
    { id: 'tick', kicker: 'Daytime cron', glyph: '◷', title: '3-5 posts a day', detail: 'half-hourly slots · a workflow picks a few' },
    { id: 'find', kicker: 'Step 1 · Find', glyph: '⌕', title: 'Find relevant qualified posts', detail: 'fresh < 48h · on-boundary · answerable' },
    { id: 'gate', kicker: 'Step 2 · Gate', glyph: '⚖', title: 'Quality gate', detail: 'grounded · room temp OK · zero is fine' },
    { id: 'write', kicker: 'Step 3 · Write', glyph: '✎', title: 'One value comment', detail: 'pure value, human voice · no links' },
    { id: 'record', kicker: 'Step 4 · Record', glyph: '◈', title: 'Post or draft · log it', detail: 'post or hold · update the ledger' },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'Comment board',
      sub: 'drafted → posted',
      columns: [
        ['Drafted', [
          ['RC-48', "r/LLMDevs — bugs aren't in the prompt", 'awaiting review'],
          ['RC-47', 'r/ClaudeAI — self-verify before shipping', 'awaiting review'],
        ]],
        ['Posted', [
          ['RC-45', 'r/AI_Agents — isolate token-heavy calls', '+6 karma'],
          ['RC-44', 'r/DesignSystems — shared style-guide.md', '+4 karma'],
          ['RC-41', 'r/vibecoding — smoke-test the money flows', '+2 karma'],
        ]],
        ['Skipped', [
          ['RC-46', 'r/FigmaDesign — thread went cold', 'stale'],
        ]],
      ],
    },
    { type: 'metric', label: 'Comment karma', series: [0, 1, 1, 3, 4, 6, 9, 11, 15, 19], note: 'value comments compound — karma is the by-product of being useful.' },
  ],
}

const CHANGELOG_BROADCASTER: FlowSpec = {
  worktreeLabel: '', // no worktree — it drafts announcements, it never touches code
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify gh / git log + channels', detail: 'smoke-test one listing · agree voice & channels' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every Mon · 9am', detail: 'reviews what merged since the last run' },
    { id: 'review', kicker: 'Step 1 · Review', glyph: '⌕', title: "Read the week's merges", detail: 'user-facing changes only, not internal churn' },
    { id: 'distill', kicker: 'Step 2 · Distill', glyph: '✎', title: 'One changelog entry', detail: 'features / fixes / improvements, in user language' },
    { id: 'draft', kicker: 'Step 3 · Draft', glyph: '✉', title: 'Social post drafts', detail: 'for the agreed channels · never auto-posts' },
  ],
  dashboard: [
    {
      type: 'embed',
      heading: 'Newest changelog draft',
      title: 'Week of Jul 21 — changelog + posts',
      date: '2026-07-27',
      lines: [
        '3 features, 2 fixes distilled from 14 merged PRs',
        'New: bundle carousel on the dashboard',
        'Fixed: timeline device filter on mobile',
        'Drafts held for your review — nothing auto-posted',
      ],
    },
    { type: 'metric', label: 'Changes announced', series: [2, 4, 3, 5, 4, 6, 5, 7], note: 'each is a reviewed draft you approved — never an auto-post.' },
  ],
}

const METRICS_DIGEST: FlowSpec = {
  worktreeLabel: '', // no worktree — read-only against the analytics source
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify analytics read access', detail: 'PostHog / warehouse / DB · one smoke query · agree the KPI' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 8am', detail: 'pulls the latest window' },
    { id: 'pull', kicker: 'Step 1 · Pull', glyph: '⌕', title: 'Query the agreed metrics', detail: 'read-only — never mutates the source' },
    { id: 'compare', kicker: 'Step 2 · Compare', glyph: '⚖', title: 'Against recent history', detail: 'normal range vs. a real drop or spike' },
    { id: 'report', kicker: 'Step 3 · Report', glyph: '✎', title: 'One dated digest', detail: 'leads with the KPI · flags anomalies plainly' },
  ],
  dashboard: [
    { type: 'metric', label: 'Primary KPI — signups', series: [118, 124, 121, 130, 127, 135, 133, 141, 138, 146], note: 'anomalies get named plainly; a normal day says so.' },
    {
      type: 'embed',
      heading: 'Newest digest',
      title: 'Metrics — daily digest',
      date: '2026-07-08',
      lines: [
        'Signups 146 (▲ vs 7-day avg 134) — healthy',
        'Activation 41% — in normal range',
        'No anomalies today; nothing needs you',
      ],
    },
  ],
}

const FUNNEL_WATCH: FlowSpec = {
  worktreeLabel: '', // no worktree — read-only against the funnel data
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify funnel read access', detail: 'agree the steps + the conversion rate that matters' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 8am', detail: 'pulls each step for the latest window' },
    { id: 'compute', kicker: 'Step 1 · Compute', glyph: '⌕', title: 'Step-to-step rates', detail: 'plus the overall conversion' },
    { id: 'compare', kicker: 'Step 2 · Compare', glyph: '⚖', title: 'Against the baseline', detail: 'a real drop beyond normal daily variance' },
    { id: 'alert', kicker: 'Step 3 · Alert', glyph: '⚑', title: 'Alert with evidence', detail: 'which step, how far, likely suspects · quiet when healthy' },
  ],
  dashboard: [
    { type: 'metric', label: 'Signup → paid %', series: [4.2, 4.4, 4.1, 4.3, 4.5, 4.2, 4.4, 4.6, 4.3, 4.5], note: 'healthy days are a short log line — no alarm.' },
    {
      type: 'embed',
      heading: 'Latest check',
      title: 'Funnel watch — daily',
      date: '2026-07-08',
      lines: [
        'All steps within normal variance — quiet day',
        'signup → activate 38% (baseline 37%)',
        'activate → paid 12% (baseline 12%)',
      ],
    },
  ],
}

const MORNING_BRIEFING: FlowSpec = {
  worktreeLabel: '', // no worktree — it gathers and writes, never touches code
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify every source', detail: 'weather · calendar · your topics — each smoke-tested once' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 6am', detail: 'before your day starts' },
    { id: 'gather', kicker: 'Step 1 · Gather', glyph: '⌕', title: 'Pull the agreed pieces', detail: 'weather, schedule, topic highlights — never invented' },
    { id: 'compose', kicker: 'Step 2 · Compose', glyph: '✎', title: 'One skimmable briefing', detail: 'a source down? it says so, never pads' },
  ],
  dashboard: [
    { type: 'calendar', heading: 'Briefings calendar', monthLabel: 'July 2026', days: 31, firstWeekday: 2, reportDays: [1, 2, 3, 4, 6, 7, 8] },
    {
      type: 'embed',
      heading: "Today's briefing",
      title: 'Morning briefing',
      date: '2026-07-08',
      lines: [
        '18–24°C, clear morning, rain after 6pm',
        '3 meetings — first at 10:00, gap 2–4pm',
        'Your topics: 2 launches, 1 pricing move worth a look',
      ],
    },
  ],
}

const HOMEBREW_UPDATER: FlowSpec = {
  worktreeLabel: '', // no worktree — it manages brew packages, not a repo
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Agree the allowlist', detail: 'pre-authorized low-risk formulae + the key tools to verify' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Weekly (your choice)', detail: 'brew update · brew outdated' },
    { id: 'upgrade', kicker: 'Step 1 · Upgrade', glyph: '✎', title: 'Allowlist only', detail: 'majors & heavy-dependent packages are flagged, not touched' },
    { id: 'verify', kicker: 'Step 2 · Verify', glyph: '▷', title: 'Key tools still run', detail: 'broke something? report + suggest the rollback' },
  ],
  dashboard: [
    {
      type: 'embed',
      heading: 'Latest update report',
      title: 'Homebrew — weekly update',
      date: '2026-07-06',
      lines: [
        '4 allowlisted upgrades applied, all tools verified',
        'node 22.4 → 22.5 · gh 2.52 → 2.53 · jq, ripgrep',
        'Held: postgresql 15 → 16 (major — needs your call)',
      ],
    },
    { type: 'metric', label: 'Outdated packages', series: [11, 8, 9, 6, 7, 4, 5, 3], note: 'the held list is only ever majors awaiting your call.', betterDown: true },
  ],
}

const DAILY_LESSON: FlowSpec = {
  worktreeLabel: '', // no worktree — it writes lessons, never touches code
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Agree topic + arc', detail: 'what to learn, how deep · a rough beginner→fluent arc' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 7am', detail: 'one lesson a day, rides the calendar' },
    { id: 'next', kicker: 'Step 1 · Pick up', glyph: '⌕', title: 'The natural next step', detail: 'builds on the arc so far — never repeats' },
    { id: 'write', kicker: 'Step 2 · Teach', glyph: '✎', title: 'One short lesson', detail: 'one idea · a concrete example · a tiny exercise' },
  ],
  dashboard: [
    { type: 'calendar', heading: 'Lessons calendar', monthLabel: 'July 2026', days: 31, firstWeekday: 2, reportDays: [1, 2, 3, 6, 7, 8] },
    {
      type: 'embed',
      heading: 'Newest lesson',
      title: 'Lesson 8 — the subjunctive, gently',
      date: '2026-07-08',
      lines: [
        'One idea: wishes & doubts take a different mood',
        'Example: "Espero que tengas razón."',
        'Exercise: rewrite 3 sentences from lesson 6',
      ],
    },
  ],
}

const TEST_GUARDIAN: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify the suite runs', detail: 'one smoke run · confirm how coverage is measured' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every Mon · 6am', detail: 'one meaningful test a week' },
    { id: 'find', kicker: 'Step 1 · Find', glyph: '⌕', title: 'Riskiest untested path', detail: 'core logic & error branches — never coverage padding' },
    { id: 'write', wt: true, kicker: 'Step 2 · Write', glyph: '✎', title: 'One solid test', detail: 'in isolation, off the main branch' },
    { id: 'prove', wt: true, kicker: 'Step 3 · Prove', glyph: '▷', title: 'Passes — and fails right', detail: 'green now, red when the behavior breaks' },
    { id: 'ship', wt: true, kicker: 'Step 4 · Ship', glyph: '⑂', title: 'Open a PR', detail: 'no stacking on an open PR' },
  ],
  dashboard: [
    { type: 'metric', label: 'Coverage %', series: [61, 61, 62, 63, 63, 64, 65, 65, 66, 67], note: 'one meaningful test a week — climbs steadily, not overnight.' },
    {
      type: 'embed',
      heading: 'Newest test PR',
      title: 'Guard the retry backoff path',
      date: '2026-07-06',
      lines: [
        'Riskiest gap: transient-failure retry never tested',
        'Proven: fails when the backoff is removed',
        'PR #218 — one test, opened for review',
      ],
    },
  ],
}

const SECURITY_SWEEP: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify the sweep tools', detail: 'audit source · git history · CI workflow files' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every Mon · 6am', detail: 'three surfaces, one pass' },
    { id: 'sweep', kicker: 'Step 1 · Sweep', glyph: '⌕', title: 'Advisories · secrets · CI pins', detail: 'deps vs. advisories · leaked keys · mutable action tags' },
    { id: 'judge', kicker: 'Step 2 · Judge', glyph: '⚖', title: 'Provably safe only', detail: 'clean patch bumps & hardened pins — the rest is flagged' },
    { id: 'ship', wt: true, kicker: 'Step 3 · Ship', glyph: '⑂', title: 'Open a PR', detail: 'never leaks a secret into the report or PR' },
  ],
  dashboard: [
    { type: 'metric', label: 'Open advisories', series: [5, 4, 4, 3, 2, 2, 1, 1, 0, 1], note: '0 = a clean sweep — a quiet report, no PR.', betterDown: true },
    {
      type: 'embed',
      heading: 'Latest sweep',
      title: 'Security sweep — weekly',
      date: '2026-07-06',
      lines: [
        '1 advisory patched, 2 CI actions pinned to SHAs',
        'lodash GHSA-…-qxrp — clean patch bump, PR opened',
        'Secret scan: nothing leaked in recent commits',
      ],
    },
  ],
}

const CI_DOCTOR: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify CI history reads', detail: 'gh or the provider API · one listing as a smoke test' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every day · 7am', detail: 'reads the recent runs' },
    { id: 'hunt', kicker: 'Step 1 · Hunt', glyph: '⌕', title: 'The worst offender', detail: 'flaky test · creeping duration · retry-prone job' },
    { id: 'fix', wt: true, kicker: 'Step 2 · Fix', glyph: '✎', title: 'Stabilize or speed up', detail: 'a real fix, verified in isolation' },
    { id: 'quarantine', wt: true, kicker: 'Step 3 · Or quarantine', glyph: '⚑', title: 'Skip with a linked issue', detail: 'only when a genuine fix is not safe yet' },
    { id: 'ship', wt: true, kicker: 'Step 4 · Ship', glyph: '⑂', title: 'Open a PR', detail: 'one offender a day, no stacking' },
  ],
  dashboard: [
    { type: 'metric', label: 'Flaky failures / week', series: [9, 7, 8, 5, 6, 4, 3, 3, 2, 1], note: 'a healthier pipeline emerges over a week or two.', betterDown: true },
    {
      type: 'embed',
      heading: 'Latest diagnosis',
      title: 'CI doctor — daily',
      date: '2026-07-08',
      lines: [
        'Worst offender: e2e checkout test, 4 retries this week',
        'Root cause: unwaited network idle — stabilized',
        'PR #305 opened · suite 2m faster',
      ],
    },
  ],
}

const BUG_VIGIL: FlowSpec = {
  worktreeLabel: '', // no worktree — it captures evidence; the fix is your call
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Describe bug + verify a tripwire', detail: 'symptom & finish condition · smoke-test the observation path' },
    { id: 'tick', kicker: 'On cadence', glyph: '◷', title: 'Patrol cadence (you set it)', detail: 'stakes out the observation path' },
    { id: 'patrol', kicker: 'Step 1 · Patrol', glyph: '⌕', title: 'Watch for a recurrence', detail: 'tracker / logs / metric / reproducible check' },
    { id: 'capture', kicker: 'Step 2 · Capture', glyph: '◈', title: 'Full context, one report', detail: 'stack trace, inputs, timing — enough to fix it' },
    { id: 'finish', finish: true, kicker: 'When captured', glyph: '⚑', title: 'Finish the loop', detail: 'one clean capture (or the give-up window) closes it' },
  ],
  dashboard: [
    {
      type: 'embed',
      heading: 'Latest patrol',
      title: 'Bug vigil — intermittent export crash',
      date: '2026-07-08',
      lines: [
        'No recurrence this patrol — 14 quiet checks so far',
        'Tripwire: Sentry issue EXPORT-512 + error-rate query',
        'Finish: one clean capture with full context',
      ],
    },
    { type: 'metric', label: 'Recurrences captured', series: [0, 0, 0, 0, 0, 0, 1], note: 'the capture is the payoff — then the loop closes itself.' },
  ],
}

const RELEASE_SHEPHERD: FlowSpec = {
  worktreeLabel: '', // no worktree — strictly report-only, it never mutates the release
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Confirm release + signals', detail: 'version & date · CI, advisories, docs, rollback plan readable' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Daily until release day', detail: 'one readiness pass a day' },
    { id: 'walk', kicker: 'Step 1 · Walk', glyph: '⌕', title: 'The readiness checklist', detail: 'CI green · advisories clear · docs & changelog · rollback plan' },
    { id: 'report', kicker: 'Step 2 · Report', glyph: '✎', title: 'Name the drift plainly', detail: 'what still needs doing — report-only, never mutates' },
    { id: 'finish', finish: true, kicker: 'On release day', glyph: '⚑', title: 'Final go/no-go, then done', detail: 'ships (or is called off) — the loop closes' },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'Readiness board',
      sub: 'clear → drift',
      columns: [
        ['Clear', [
          ['CI', 'Release branch green', 'checked today'],
          ['SEC', 'No open advisories', 'checked today'],
          ['ROLL', 'Rollback plan in place', 'checked Mon'],
        ]],
        ['Drift', [
          ['DOCS', 'Changelog missing 2 merged features', 'flagged today'],
        ]],
      ],
    },
    { type: 'metric', label: 'Checklist items clear', series: [3, 4, 4, 5, 5, 6, 7], note: 'a final go/no-go report files on release day.' },
  ],
}

const OUTCOME_WATCH: FlowSpec = {
  worktreeLabel: '', // no worktree — it reads the metric, it changes nothing
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Verify the deciding metric', detail: 'one smoke read · agree threshold + decision window' },
    { id: 'tick', kicker: 'On cadence', glyph: '◷', title: 'Fits the metric (you set it)', detail: 'checks as often as the data moves' },
    { id: 'read', kicker: 'Step 1 · Read', glyph: '⌕', title: 'Read the metric', detail: 'analytics / events / logs — the verified path' },
    { id: 'judge', kicker: 'Step 2 · Judge', glyph: '⚖', title: 'Against the threshold', detail: 'pass, fail, or still inside the window' },
    { id: 'finish', finish: true, kicker: 'At the verdict', glyph: '⚑', title: 'Conclusive verdict, then done', detail: 'threshold reached or window closed — the loop finishes' },
  ],
  dashboard: [
    { type: 'metric', label: 'Deciding metric — conversion %', series: [3.1, 3.4, 3.2, 3.8, 3.9, 4.2, 4.4], note: 'verdict: clearly up after N days, or the window closes.' },
    {
      type: 'embed',
      heading: 'Latest reading',
      title: 'Outcome watch — pricing change',
      date: '2026-07-08',
      lines: [
        'Day 5 of 14 — conversion 4.4% vs baseline 3.2%',
        'Trend holds above the +0.8pt threshold so far',
        'Verdict files itself when the window closes',
      ],
    },
  ],
}


const SEO_SCOUT: FlowSpec = {
  worktreeLabel: 'Isolated git worktree · off main',
  nodes: [
    { id: 'setup', setup: true, kicker: 'Before first run', glyph: '⚙', title: 'Wire Search Console + the map', detail: 'smoke-test one live pull · breadwinner protected · bot queries tagged' },
    { id: 'tick', kicker: 'On schedule', glyph: '◷', title: 'Every Mon', detail: 'one bet max · skipping is healthy' },
    { id: 'verdict', kicker: 'Step 1 · Verdict', glyph: '⚖', title: 'Day-7 verdicts first', detail: 'live daily series · dated · scale or leave' },
    { id: 'radar', kicker: 'Step 2 · Radar', glyph: '⌕', title: 'Read your own feed', detail: 'bookmarks & communities — not keyword tools' },
    { id: 'bet', wt: true, kicker: 'Step 3 · Bet', glyph: '✎', title: 'Place one cheap bet', detail: 'one guide + up to 4 supporting pages' },
    { id: 'ship', wt: true, kicker: 'Step 4 · Ship', glyph: '⑂', title: 'One PR, human merges', detail: 'no new bet while one is open' },
  ],
  dashboard: [
    {
      type: 'kanban',
      heading: 'Bet board',
      sub: 'thesis → live → verdict',
      columns: [
        ['Live', [
          ['BET-7', 'context compaction — guide + 4 pages', 'day 5 of 7'],
        ]],
        ['Scaled', [
          ['BET-5', 'loop engineering cluster', 'daily loop spun up'],
          ['BET-6', '"X is dead" displacement page', '295 clicks/wk'],
        ]],
        ['Left', [
          ['BET-4', 'loops vs graphs', '16 impressions · left'],
        ]],
      ],
    },
    { type: 'metric', label: 'Organic clicks (28d)', series: [112, 340, 820, 2079, 3900, 6900, 10400, 13831], note: 'bets are cheap; the verdicts decide what gets scaled.' },
  ],
}

export const FLOWS: Record<string, FlowSpec> = {
  'support-triage': SUPPORT_TRIAGE,
  'reddit-karma': REDDIT_KARMA,
  'seo-scout': SEO_SCOUT,
  'react-doctor': REACT_DOCTOR,
  'docs-sweep': DOCS_SWEEP,
  'error-sweep': ERROR_SWEEP,
  housekeeper: HOUSEKEEPER,
  'dependency-triage': DEPENDENCY_TRIAGE,
  'market-research': MARKET_RESEARCH,
  'follow-up-tracker': FOLLOW_UP,
  'changelog-broadcaster': CHANGELOG_BROADCASTER,
  'metrics-digest': METRICS_DIGEST,
  'funnel-watch': FUNNEL_WATCH,
  'morning-briefing': MORNING_BRIEFING,
  'homebrew-updater': HOMEBREW_UPDATER,
  'daily-lesson': DAILY_LESSON,
  'test-guardian': TEST_GUARDIAN,
  'security-sweep': SECURITY_SWEEP,
  'ci-doctor': CI_DOCTOR,
  'bug-vigil': BUG_VIGIL,
  'release-shepherd': RELEASE_SHEPHERD,
  'outcome-watch': OUTCOME_WATCH,
}

/** Whether a template has a preview — drives the modal's two-column layout. */
export const hasLoopFlow = (name: string): boolean => name in FLOWS

// ── Derived: the public detail page's trigger -> steps -> outputs diagram ────

/** What a widget the loop maintains IS, for the diagram's output nodes. */
const OUTPUT_KIND: Record<Widget['type'], { kind: string; glyph: string }> = {
  kanban: { kind: 'Board', glyph: '▤' },
  embed: { kind: 'Report', glyph: '▢' },
  metric: { kind: 'Metric', glyph: '◔' },
  calendar: { kind: 'Calendar', glyph: '▦' },
}

export interface FlowDiagramNode {
  glyph: string
  /** The small uppercase kicker above the label ("On schedule", "Step 2", "Report"). */
  kicker: string
  label: string
  /** True for a step the loop runs inside its isolated git worktree. */
  worktree?: boolean
}

export interface FlowDiagram {
  /** The one-time gate before the recurring cycle, when the template declares one. */
  setup?: FlowDiagramNode
  trigger: FlowDiagramNode
  steps: FlowDiagramNode[]
  /** Where the work lands: the dashboard surfaces this loop maintains. */
  outputs: FlowDiagramNode[]
  /** A closed loop ends at its goal instead of looping back. */
  closes: boolean
  worktreeLabel: string
}

/**
 * Fold a `FlowSpec` into the flat trigger -> steps -> outputs shape the static
 * diagram draws. Derived, never a second hand-authored spec: the nodes come from the
 * SAME `nodes` the modal animates, and the outputs from the SAME dashboard widgets it
 * previews — so a template can never describe two different flows.
 *
 * Pure: no clock, no DOM, no React. Returns null for a template with no spec.
 */
export function templateFlowDiagram(name: string): FlowDiagram | null {
  const spec = FLOWS[name]
  if (!spec) return null
  const setupDef = spec.nodes.find((n) => n.setup)
  const triggerDef = spec.nodes.find((n) => !n.setup && !n.finish)
  if (!triggerDef) return null
  const stepDefs = spec.nodes.filter((n) => n !== setupDef && n !== triggerDef && !n.finish)
  const node = (n: NodeDef): FlowDiagramNode => ({
    glyph: n.glyph,
    kicker: n.kicker,
    label: n.title,
    ...(n.wt ? { worktree: true } : {}),
  })
  return {
    ...(setupDef ? { setup: node(setupDef) } : {}),
    trigger: node(triggerDef),
    steps: stepDefs.map(node),
    outputs: spec.dashboard.map((w) => {
      const meta = OUTPUT_KIND[w.type]
      return { glyph: meta.glyph, kicker: meta.kind, label: outputLabel(w) }
    }),
    closes: spec.nodes.some((n) => n.finish),
    worktreeLabel: spec.worktreeLabel,
  }
}

/** A widget's own heading is its honest name on the dashboard; a metric has none. */
function outputLabel(w: Widget): string {
  return w.type === 'metric' ? w.label : w.heading
}
