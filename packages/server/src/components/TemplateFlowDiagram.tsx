import { templateFlowDiagram, type FlowDiagramNode } from '../lib/templateFlow'

/**
 * The public template detail's WORKFLOW diagram (`/templates/<slug>`): trigger ->
 * the loop's steps -> where the work lands, in the house diagram language (bordered
 * cards on an accent rail, mono micro text, solid arrow connectors — the same
 * vocabulary as the playbook's role cards).
 *
 * Entirely STATIC: plain HTML/CSS grid plus tiny inline SVG arrows, no measuring, no
 * effects, no graph library — so it renders in the server HTML the market route already
 * ships (that route SSRs on purpose, for crawlers and unfurlers).
 *
 * Data-driven and single-sourced: `templateFlowDiagram` folds the SAME per-template
 * `FlowSpec` the compose modal animates (`lib/templateFlow.tsx`) into this flat shape —
 * steps from its nodes, outputs from the dashboard surfaces it maintains. A template
 * with no spec renders NOTHING rather than an invented flow.
 */
export function TemplateFlowDiagram({ name }: { name: string }) {
  const flow = templateFlowDiagram(name)
  if (!flow) return null
  const groups = groupSteps(flow.steps)

  return (
    <section className="mt-9">
      <h2 className="text-label font-semibold text-display">How a run flows</h2>
      <div className="mt-3 rounded-card border border-hairline bg-surface p-5">
        {/* A one-time gate sits ABOVE the cycle — it happens once, before run one. */}
        {flow.setup && (
          <div className="mb-4 flex flex-col items-center">
            <div className="w-full max-w-[22rem] rounded-control border border-dashed border-wire bg-raised px-3 py-2 text-center">
              <div className="font-mono text-micro text-secondary">{flow.setup.kicker}</div>
              <div className="mt-0.5 text-caption font-medium text-primary">
                <span aria-hidden className="mr-1.5 text-secondary">
                  {flow.setup.glyph}
                </span>
                {flow.setup.label}
              </div>
            </div>
            <Arrow className="mt-1 h-4 w-3" vertical />
          </div>
        )}

        <div className="grid min-w-0 items-center gap-2 sm:grid-cols-[minmax(0,0.9fr)_28px_minmax(0,1.3fr)_28px_minmax(0,1fr)]">
          <FlowCard node={flow.trigger} tone="warn" />
          <Connector />
          <div className="flex min-w-0 flex-col gap-2">
            {groups.map((g, i) =>
              g.worktree ? (
                <div key={i} className="relative rounded-control border border-dashed border-interactive/45 p-2 pt-3.5">
                  <span className="absolute -top-2 left-2.5 bg-surface px-1.5 font-mono text-micro text-interactive">
                    {flow.worktreeLabel}
                  </span>
                  <div className="flex flex-col gap-2">
                    {g.steps.map((s) => (
                      <FlowCard key={s.label} node={s} tone="interactive" />
                    ))}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-2">
                  {g.steps.map((s) => (
                    <FlowCard key={s.label} node={s} tone="interactive" />
                  ))}
                </div>
              ),
            )}
          </div>
          <Connector />
          <div className="flex min-w-0 flex-col gap-2">
            {flow.outputs.map((o) => (
              <FlowCard key={o.label} node={o} tone="success" />
            ))}
          </div>
        </div>

        {/* What happens after the outputs land: loop back, or stop for good. */}
        <div className="mt-4 border-t border-hairline pt-3 text-center font-mono text-micro text-secondary">
          {flow.closes ? (
            <>
              <span aria-hidden className="mr-1.5 text-success">
                ✓
              </span>
              closed loop — it finishes itself once the goal is met
            </>
          ) : (
            <>
              <span aria-hidden className="mr-1.5">
                ↻
              </span>
              open loop — repeats on the next tick, picking up where it left off
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** One node card: accent rail + glyph, its own kicker, its own label. */
function FlowCard({ node, tone }: { node: FlowDiagramNode; tone: 'warn' | 'interactive' | 'success' }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-control border border-wire bg-surface py-2 pl-4 pr-3">
      <span aria-hidden className={`absolute inset-y-1.5 left-0 w-1 rounded-r-full ${BAR[tone]}`} />
      <div className="font-mono text-micro text-secondary">{node.kicker}</div>
      <div className="mt-0.5 flex min-w-0 items-start gap-1.5">
        <span aria-hidden className={`shrink-0 text-caption ${INK[tone]}`}>
          {node.glyph}
        </span>
        <span className="min-w-0 text-caption font-medium leading-snug text-primary">{node.label}</span>
      </div>
    </div>
  )
}

const BAR = { warn: 'bg-rubik-orange', interactive: 'bg-interactive', success: 'bg-rubik-green' } as const
const INK = { warn: 'text-warn', interactive: 'text-interactive', success: 'text-success' } as const

/** The gap between two columns: a solid arrow, horizontal on desktop and turned
 *  down the page when the grid stacks to one column. */
function Connector() {
  return (
    <div className="flex items-center justify-center py-1 sm:py-0">
      <Arrow className="h-3 w-6 rotate-90 sm:rotate-0" />
    </div>
  )
}

function Arrow({ className, vertical }: { className?: string; vertical?: boolean }) {
  const c = 'var(--color-wire)'
  return (
    <svg aria-hidden className={className} viewBox={vertical ? '0 0 12 32' : '0 0 32 12'} preserveAspectRatio="none">
      {vertical ? (
        <>
          <line x1="6" y1="0" x2="6" y2="24" stroke={c} strokeWidth="1.5" />
          <path d="M1.5,23 L6,31 L10.5,23 z" fill={c} />
        </>
      ) : (
        <>
          <line x1="0" y1="6" x2="24" y2="6" stroke={c} strokeWidth="1.5" />
          <path d="M23,1.5 L31,6 L23,10.5 z" fill={c} />
        </>
      )}
    </svg>
  )
}

/** Consecutive worktree steps share ONE dashed isolation box (that is what the
 *  worktree actually is — one checkout the whole stretch runs in), so the grouping
 *  follows the spec's own `wt` flags instead of a second hand-kept list. */
function groupSteps(steps: FlowDiagramNode[]): { worktree: boolean; steps: FlowDiagramNode[] }[] {
  const groups: { worktree: boolean; steps: FlowDiagramNode[] }[] = []
  for (const s of steps) {
    const wt = !!s.worktree
    const last = groups[groups.length - 1]
    if (last && last.worktree === wt) last.steps.push(s)
    else groups.push({ worktree: wt, steps: [s] })
  }
  return groups
}
