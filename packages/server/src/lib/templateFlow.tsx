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

export const FLOWS: Record<string, FlowSpec> = {
  'support-triage': SUPPORT_TRIAGE,
  'reddit-karma': REDDIT_KARMA,
  'react-doctor': REACT_DOCTOR,
  'docs-sweep': DOCS_SWEEP,
  'error-sweep': ERROR_SWEEP,
  housekeeper: HOUSEKEEPER,
  'dependency-triage': DEPENDENCY_TRIAGE,
  'market-research': MARKET_RESEARCH,
  'follow-up-tracker': FOLLOW_UP,
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
