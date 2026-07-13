import { Fragment, useEffect, useRef, useState } from 'react'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'

/**
 * LoopPlaybook - the static education band at the bottom of the dashboard.
 *
 * Sells the method behind the product in four beats: the anatomy of a good
 * loop, the three roles serious loops grow into, the evolve cycle that makes
 * a loop antifragile, and what Loopany scaffolds by default. Pure content -
 * no data wiring, so the dashboard poll never touches it. The pixel face
 * (font-pixel) is reserved for kickers and the big titles; everything else
 * stays on the app tokens so light/dark adapt for free.
 */
export function LoopPlaybook({ onStart }: { onStart: () => void }) {
  return (
    <section className="mt-24 border-t border-hairline pt-16">
      {/* Opener */}
      <div className="text-center">
        <div className="font-pixel text-label uppercase tracking-[0.18em] text-secondary">
          The loop playbook
        </div>
        <h2 className="mx-auto mt-3 max-w-[620px] font-pixel text-[clamp(24px,4vw,34px)] leading-[1.15] text-display">
          Anatomy of good loops
        </h2>
        <p className="mx-auto mt-4 max-w-[520px] text-body leading-relaxed text-secondary">
          That is the easy 5%. The real work is the structure that lets you walk away
          while it runs. Every good loop we have seen follows the same playbook.
        </p>
      </div>

      {/* 01 - anatomy */}
      <PlaybookHead num="01" title="Four parts of a good loop" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <IdeaCard
          title="Contract"
          caption="One file the agent re-reads every run: the goal, the boundary fence, the steps. The fence decides whether you can walk away."
        >
          <DocMock
            name="contract.md"
            lines={[
              { h: '## Goal' },
              { skel: 'w-4/5' },
              { h: '## Boundaries' },
              { hot: 'ship it yourself vs ask a human' },
              { skel: 'w-3/5' },
              { h: '## SOP' },
              { skel: 'w-4/6' },
            ]}
          />
        </IdeaCard>

        <IdeaCard
          title="State + logs"
          caption="Durable memory across runs, so it never re-does work and every lesson sticks. Month three is smarter than week one."
        >
          <DocMock
            name="state.md"
            lines={[
              { h: '## State' },
              { t: 'hypothesis: credit-wall users reply 3x' },
              { t: 'skip: known-noise fingerprints' },
              { h: '## Logs' },
              { t: '07-08 fixed null-team, PR #1027' },
              { t: '07-07 nothing new, clean stop' },
            ]}
          />
        </IdeaCard>

        <IdeaCard
          title="Verifier"
          caption="Work loops with verify until there is evidence a human can glance at. No proof, not done."
        >
          <VerifierDiagram />
        </IdeaCard>

        <IdeaCard
          title="Trigger"
          caption="Pick the cheapest trigger that fits: a push toward a goal, a schedule, or an event gate so empty runs cost nothing."
        >
          <div className="flex h-full flex-col justify-center gap-2">
            <TriggerRow code="while (goal not met)" label="continuous push" />
            <TriggerRow code="0 6 * * *" label="cron schedule" />
            <TriggerRow code="on: new ticket" label="event, gated" />
          </div>
        </IdeaCard>
      </div>

      {/* 02 - roles */}
      <PlaybookHead num="02" title="Serious loops split into three roles" />
      <p className="mx-auto -mt-3 mb-8 max-w-[590px] text-center text-body text-secondary">
        Simple loops are one agent doing the whole job. Once a loop ships real work to
        real people, it splits: one agent finds the work, one does it in an isolated
        lane, one proves it. You approve evidence, not diffs.
      </p>
      <RolesFlow />

      {/* 03 - evolve */}
      <PlaybookHead num="03" title="Evolve, or the loop stays as dumb as day one" />
      <div className="rounded-card border border-hairline bg-surface p-6 sm:p-8">
        <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
          <p className="text-body leading-relaxed text-primary">
            Fragile systems break on a bad run. Robust ones survive it. An antifragile
            loop gets stronger from it: a periodic evolve pass reads the last dozen runs
            and asks where money was wasted, which boundary is too loose, which mistake
            keeps repeating.
          </p>
          <p className="text-body leading-relaxed text-secondary">
            Its output is not product work. It is changes to the loop itself: a tighter
            contract, a cheaper trigger, mechanical steps folded into scripts and skills.
            A loop that improves the loop.
          </p>
        </div>
        <div className="mt-6 border-t border-hairline pt-6">
          <EvolveTimeline />
        </div>
      </div>

      {/* 03b - evolve's payoff: compute-per-run over a loop's lifetime */}
      <div className="mt-4 rounded-card border border-hairline bg-surface p-6 sm:p-8">
        <div className="mx-auto max-w-[580px] text-center">
          <div className="font-pixel text-[clamp(15px,2vw,19px)] leading-snug text-display">
            Every run compiles a cheaper, smarter next run
          </div>
          <p className="mt-2.5 text-body leading-relaxed text-secondary">
            The payoff shows up on the bill and in the work. Each pass folds what the loop
            learned into scripts, skills and a tighter contract, so the next run reasons
            less, misses less, and costs less. Born agentic, it graduates to a cheap
            script, and the agent only wakes back up when something surprising happens.
          </p>
        </div>
        <div className="mt-6">
          <CostCurve />
        </div>
      </div>

      {/* 04 - the close */}
      <div className="mt-16 rounded-card bg-display px-6 py-10 text-center sm:px-10">
        <div className="font-pixel text-label uppercase tracking-[0.18em] text-paper/60">
          Built in
        </div>
        <h3 className="mx-auto mt-3 max-w-[560px] font-pixel text-[clamp(21px,3vw,28px)] leading-[1.2] text-paper">
          Loopany ships the guardrails by default
        </h3>
        <ul className="mx-auto mt-7 grid max-w-[760px] grid-cols-1 gap-x-8 gap-y-2.5 text-left sm:grid-cols-2">
          <BuiltIn>Contract, state and logs born with every loop</BuiltIn>
          <BuiltIn>Boundaries re-read at the top of every run</BuiltIn>
          <BuiltIn>Missed fires caught up, failed runs recovered</BuiltIn>
          <BuiltIn>Time, event and gated triggers: empty runs cost nothing</BuiltIn>
          <BuiltIn>An evolve pass that reviews its own run history</BuiltIn>
          <BuiltIn>A purpose-built dashboard per loop, not a log to scroll</BuiltIn>
        </ul>
        <button
          onClick={onStart}
          className="mt-9 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-paper px-6 py-2.5 text-body font-medium text-display transition-opacity hover:opacity-85"
        >
          Start a loop
          <span aria-hidden>→</span>
        </button>
        <div className="mt-3 text-caption text-paper/55">
          Describe the job. The playbook is the default, not homework.
        </div>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-paper/60 transition-colors hover:text-paper"
          >
            <GitHubIcon className="size-4" /> Open source on GitHub
          </a>
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-paper/60 transition-colors hover:text-paper"
          >
            <DiscordIcon className="size-4" /> Join the Discord
          </a>
        </div>
      </div>
    </section>
  )
}

/* ---------- shared bits ---------- */

function PlaybookHead({ num, title }: { num: string; title: string }) {
  return (
    <div className="mb-6 mt-16 flex items-baseline justify-center gap-3">
      <span className="font-pixel text-meta text-secondary">{num}</span>
      <h3 className="font-pixel text-[clamp(17px,2.4vw,21px)] text-display">{title}</h3>
    </div>
  )
}

function IdeaCard({
  title,
  caption,
  children,
}: {
  title: string
  caption: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-hairline bg-surface p-4 shadow-card">
      <div className="text-body font-semibold text-display">{title}</div>
      <div className="mt-3 flex min-h-[150px] flex-1 flex-col justify-center">{children}</div>
      <div className="mt-3 text-caption leading-snug text-secondary">{caption}</div>
    </div>
  )
}

/** A miniature markdown-file mock: header bar + mono headings, skeleton or
 *  real one-liners, and at most one highlighted "hot" boundary line. */
function DocMock({
  name,
  lines,
}: {
  name: string
  lines: { h?: string; t?: string; skel?: string; hot?: string }[]
}) {
  return (
    <div className="overflow-hidden rounded-control border border-hairline bg-raised">
      <div className="border-b border-hairline px-2.5 py-1 font-mono text-micro text-secondary">
        {name}
      </div>
      <div className="space-y-1.5 px-2.5 py-2.5">
        {lines.map((l, i) =>
          l.h ? (
            <div key={i} className="font-mono text-micro font-semibold text-primary">
              {l.h}
            </div>
          ) : l.hot ? (
            <div
              key={i}
              className="rounded-[4px] bg-interactive-soft px-1.5 py-0.5 font-mono text-micro text-interactive"
            >
              {l.hot}
            </div>
          ) : l.t ? (
            <div key={i} className="truncate font-mono text-micro text-secondary">
              {l.t}
            </div>
          ) : (
            <div key={i} className={`h-1.5 rounded-full bg-wire/60 ${l.skel ?? 'w-full'}`} />
          ),
        )}
      </div>
    </div>
  )
}

/** work -> verify, a fail/fix loop back, and the proof chip a human trusts. */
function VerifierDiagram() {
  return (
    <svg viewBox="0 0 220 168" role="img" aria-label="Work and verify loop until proof" className="mx-auto w-full max-w-[210px]">
      <defs>
        <marker id="lp-a" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-secondary)" />
        </marker>
        <marker id="lp-g" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-success)" />
        </marker>
      </defs>
      {/* fail/fix back edge */}
      <path d="M62,96 Q22,70 62,44" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" markerEnd="url(#lp-a)" />
      <text x="16" y="66" fontSize="9" fill="var(--color-accent)" fontFamily="var(--font-mono)">fail</text>
      <text x="16" y="77" fontSize="9" fill="var(--color-accent)" fontFamily="var(--font-mono)">fix</text>
      {/* run */}
      <path d="M110,52 L110,84" fill="none" stroke="var(--color-secondary)" strokeWidth="1.6" markerEnd="url(#lp-a)" />
      {/* pass */}
      <path d="M110,120 L110,138" fill="none" stroke="var(--color-success)" strokeWidth="1.6" markerEnd="url(#lp-g)" />
      {/* WORK */}
      <rect x="60" y="18" width="100" height="34" rx="8" fill="var(--color-surface)" stroke="var(--color-wire)" strokeWidth="1.3" />
      <text x="110" y="39" textAnchor="middle" fontSize="11" fill="var(--color-primary)" fontFamily="var(--font-mono)">work</text>
      {/* VERIFY */}
      <rect x="60" y="86" width="100" height="34" rx="8" fill="var(--color-surface)" stroke="var(--color-wire)" strokeWidth="1.3" />
      <text x="110" y="107" textAnchor="middle" fontSize="11" fill="var(--color-primary)" fontFamily="var(--font-mono)">verify</text>
      {/* proof chip */}
      <rect x="48" y="140" width="124" height="24" rx="12" fill="var(--color-success-soft)" stroke="var(--color-success)" strokeWidth="1.2" />
      <text x="110" y="156" textAnchor="middle" fontSize="9.5" fill="var(--color-success)" fontFamily="var(--font-mono)">✓ proof → PR</text>
    </svg>
  )
}

function TriggerRow({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="shrink-0 rounded-[5px] bg-raised px-1.5 py-0.5 font-mono text-micro text-primary">
        {code}
      </code>
      <span className="truncate text-caption text-secondary">{label}</span>
    </div>
  )
}

/**
 * The three roles laid out as a dispatch map (the article's infographic, on
 * app tokens): a trigger wakes the orchestrator, which fans tasks out to
 * parallel executor→verifier lanes; every lane ends in proof, and every run
 * reports back into state + logs. Warm ink = work being dispatched, green =
 * proof flowing home. Real HTML cards carry all the text; SVG only draws the
 * connectors. Wide by nature, so the diagram scrolls inside its own pane on
 * narrow screens (never the page). Lane rows are fixed-height so the fan-out
 * SVG's coordinates line up with the row centers by construction.
 */
const LANE_ROWS = ['row-start-2', 'row-start-3', 'row-start-4'] as const

type RoleTone = 'warn' | 'interactive' | 'success'

/** Slot index + highlight ink for the diagram's 9s narrative cycle (the
 *  `.lpb-stage` / `.lpb-flow` rules in app.css). */
function stageStyle(i: number, tone: RoleTone): React.CSSProperties {
  return { '--lpb-i': i, '--lpb-c': `var(--color-${tone})` } as React.CSSProperties
}

const ROLE_BADGE: Record<RoleTone, string> = {
  warn: 'bg-warn-soft text-warn',
  interactive: 'bg-interactive-soft text-interactive',
  success: 'bg-success-soft text-success',
}

/** A role's icon in a soft-tinted square, sized for card headers. */
function RoleBadge({ tone, children }: { tone: RoleTone; children: React.ReactNode }) {
  return (
    <span aria-hidden className={`flex size-6 shrink-0 items-center justify-center rounded-[7px] ${ROLE_BADGE[tone]}`}>
      {children}
    </span>
  )
}

/** Orchestrator: a dispatch node - one point, three rays. */
function OrchestratorIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8.6" r="1.7" fill="currentColor" stroke="none" />
      <path d="M8 6.4 V2.6 M9.7 9.8 L12.9 12 M6.3 9.8 L3.1 12" />
      <path d="M4.9 3.4 A5.4 5.4 0 0 1 11.1 3.4" opacity="0.45" />
    </svg>
  )
}

/** Executor: the isolated box. */
function ExecutorIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 1.8 L14 4.8 V11.2 L8 14.2 L2 11.2 V4.8 Z" />
      <path d="M2 4.8 L8 7.8 L14 4.8 M8 7.8 V14.2" />
    </svg>
  )
}

/** Verifier: shield + check. */
function VerifierIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5 L13.5 3.5 V8 C13.5 11.2 11.2 13.6 8 14.5 C4.8 13.6 2.5 11.2 2.5 8 V3.5 Z" />
      <path d="M5.6 8.2 L7.3 9.9 L10.6 6.3" />
    </svg>
  )
}

function RolesFlow() {
  return (
    <div className="rounded-card border border-hairline bg-surface p-5 shadow-card sm:p-7">
      {/* role captions, lit in step with their stage in the diagram */}
      <div className="mb-5 grid grid-cols-1 gap-4 border-b border-hairline pb-5 sm:grid-cols-3">
        <RoleCaption
          name="Orchestrator"
          tone="warn"
          stage={0}
          icon={<OrchestratorIcon />}
          line="Wakes on the trigger and finds the task: reads what changed, picks the single most worthwhile thing this run. It never does the work itself."
        />
        <RoleCaption
          name="Executor"
          tone="interactive"
          stage={1}
          icon={<ExecutorIcon />}
          line="Does the work in an isolated box, a fresh git worktree per task, so lanes never touch your checkout or each other."
        />
        <RoleCaption
          name="Verifier"
          tone="success"
          stage={2}
          icon={<VerifierIcon />}
          line="Independently proves each result and attaches the evidence: a screenshot, a video, a fact-check. That proof is what you review."
        />
      </div>
      {/* padded inside the scroll box so the stage-highlight rings never clip */}
      <div className="-m-2 overflow-x-auto p-2">
        <div
          role="img"
          aria-label="A trigger fires the orchestrator, which dispatches tasks to parallel executor and verifier lanes; each lane ends in a PR with proof, and every run reports back into state and logs"
          className="grid min-w-[900px] grid-cols-[216px_72px_minmax(150px,1fr)_56px_minmax(170px,1fr)_56px_180px] grid-rows-[auto_repeat(3,84px)_auto] gap-y-3"
        >
          {/* trigger pill, wired into the orchestrator below */}
          <div className="col-start-1 row-start-1 flex flex-col items-center">
            <div
              className="lpb-stage inline-flex items-center gap-1.5 rounded-full border border-wire bg-surface px-4 py-1.5 font-mono text-label text-primary"
              style={stageStyle(0, 'warn')}
            >
              <span aria-hidden>⏰</span> trigger fires
            </div>
            <svg aria-hidden className="-mb-4 h-8 w-3" viewBox="0 0 12 32">
              <line x1="6" y1="0" x2="6" y2="24" stroke="var(--color-warn)" strokeWidth="1.5" />
              <path d="M1.5,23 L6,31 L10.5,23 z" fill="var(--color-warn)" />
            </svg>
          </div>

          {/* orchestrator */}
          <div
            className="lpb-stage relative col-start-1 row-span-3 row-start-2 flex flex-col overflow-hidden rounded-control border border-wire bg-surface p-4 pl-5 shadow-card"
            style={stageStyle(0, 'warn')}
          >
            <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-rubik-orange" />
            <div className="flex items-center gap-2">
              <RoleBadge tone="warn">
                <OrchestratorIcon />
              </RoleBadge>
              <span className="font-pixel text-[15px] text-display">Orchestrator</span>
            </div>
            <div className="mt-1.5 font-mono text-micro text-secondary">find the work, don't do it</div>
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              {['🐛 errors', '📥 inbox', '📈 metrics', '🔀 PRs'].map((s) => (
                <span
                  key={s}
                  className="rounded-[6px] bg-raised px-1.5 py-1 text-center font-mono text-micro text-secondary"
                >
                  {s}
                </span>
              ))}
            </div>
            <div className="mt-3 rounded-control border border-warn/50 bg-warn-soft px-2 py-1.5 text-center font-mono text-label font-medium text-warn">
              prioritise → dispatch
            </div>
            <div className="mt-2 text-center font-mono text-micro leading-snug text-secondary">
              one task per lane,
              <br />
              lanes never touch
            </div>
            <div
              className="lpb-stage mt-auto rounded-control border border-success/40 bg-success-soft px-2 py-1.5 text-center font-mono text-micro text-success"
              style={stageStyle(4, 'success')}
            >
              ✍ writes state + logs
            </div>
          </div>

          {/* fan-out: one dispatch point, three lanes (heights are fixed, so
              the curve endpoints match the row centers exactly) */}
          <svg
            aria-hidden
            className="lpb-flow col-start-2 row-span-3 row-start-2 h-full w-full"
            style={stageStyle(1, 'warn')}
            viewBox="0 0 72 276"
            preserveAspectRatio="none"
          >
            <defs>
              <marker id="rf-warn" markerWidth="8" markerHeight="8" refX="6.5" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--color-warn)" />
              </marker>
            </defs>
            <path d="M2,138 C42,138 28,42 62,42" fill="none" stroke="var(--color-warn)" strokeWidth="1.5" markerEnd="url(#rf-warn)" />
            <path d="M2,138 L62,138" fill="none" stroke="var(--color-warn)" strokeWidth="1.5" markerEnd="url(#rf-warn)" />
            <path d="M2,138 C42,138 28,234 62,234" fill="none" stroke="var(--color-warn)" strokeWidth="1.5" markerEnd="url(#rf-warn)" />
          </svg>

          {/* the three lanes */}
          {(['A', 'B', 'C'] as const).map((t, i) => {
            const rs = LANE_ROWS[i]
            const failFix = t === 'B'
            return (
              <Fragment key={t}>
                {/* executor: solid shell, dashed isolation boundary inside */}
                <div className={`col-start-3 ${rs}`}>
                  <div
                    className="lpb-stage relative flex h-full flex-col items-center justify-center rounded-control border border-wire bg-surface shadow-card"
                    style={stageStyle(1, 'interactive')}
                  >
                    <span aria-hidden className="pointer-events-none absolute inset-1.5 rounded-[7px] border border-dashed border-interactive/40" />
                    <span className="absolute -top-2 left-3 rounded bg-surface px-1.5 font-mono text-micro text-warn">
                      task {t}
                    </span>
                    <div className="flex items-center gap-2">
                      <RoleBadge tone="interactive">
                        <ExecutorIcon />
                      </RoleBadge>
                      <span className="text-meta font-semibold text-display">Executor</span>
                    </div>
                    <div className="mt-1.5 font-mono text-micro text-interactive">isolated worktree</div>
                  </div>
                </div>

                {/* hand-off, plus the fail→fix return on the middle lane */}
                <div className={`lpb-flow relative col-start-4 ${rs} flex items-center px-1`} style={stageStyle(2, 'warn')}>
                  <FlowArrow tone="warn" />
                  {failFix && (
                    <div className="absolute inset-x-1 top-[calc(50%+12px)] flex flex-col items-center">
                      <FlowArrow tone="warn" dashed flip />
                      <span className="mt-0.5 font-mono text-micro text-warn">fail→fix</span>
                    </div>
                  )}
                </div>

                {/* verifier */}
                <div className={`col-start-5 ${rs}`}>
                  <div
                    className="lpb-stage relative flex h-full flex-col items-center justify-center overflow-hidden rounded-control border border-wire bg-surface shadow-card"
                    style={stageStyle(2, 'success')}
                  >
                    <span aria-hidden className="absolute inset-y-2 right-0 w-1 rounded-l-full bg-rubik-green" />
                    <div className="flex items-center gap-2">
                      <RoleBadge tone="success">
                        <VerifierIcon />
                      </RoleBadge>
                      <span className="text-meta font-semibold text-display">Verifier</span>
                    </div>
                    <div className="mt-1.5 font-mono text-micro text-secondary">drive the app · 📸 evidence</div>
                  </div>
                </div>

                <div className={`lpb-flow col-start-6 ${rs} flex items-center px-1`} style={stageStyle(3, 'success')}>
                  <FlowArrow tone="success" />
                </div>

                {/* proof */}
                <div className={`col-start-7 ${rs} flex items-center`}>
                  <div
                    className="lpb-stage flex h-[64px] w-full flex-col items-center justify-center rounded-control border border-success/40 bg-success-soft"
                    style={stageStyle(3, 'success')}
                  >
                    <div className="font-mono text-label font-semibold text-success">✓ PR + proof</div>
                    <div className="mt-1 font-mono text-micro text-success/80">approve in seconds</div>
                  </div>
                </div>
              </Fragment>
            )
          })}

          {/* report-back rail: results flow home into state + logs */}
          <div className="lpb-flow relative col-span-full row-start-5 h-10" style={stageStyle(4, 'success')}>
            <span aria-hidden className="absolute right-[90px] top-[-22px] bottom-1/2 border-r border-dashed border-success/70" />
            <span aria-hidden className="absolute left-[107px] top-[-9px] bottom-1/2 border-l border-dashed border-success/70" />
            <svg aria-hidden className="absolute left-[102px] top-[-15px] h-2 w-[11px]" viewBox="0 0 11 8">
              <path d="M0,8 L5.5,0 L11,8 z" fill="var(--color-success)" />
            </svg>
            <span aria-hidden className="absolute left-[107px] right-[90px] top-1/2 border-t border-dashed border-success/70" />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap bg-surface px-2.5 font-mono text-micro text-success">
              every run reports back → orchestrator writes state + logs
            </span>
          </div>
        </div>
      </div>

    </div>
  )
}

/** A short connector arrow that fills its cell; `flip` reverses direction. */
function FlowArrow({ tone, dashed, flip }: { tone: 'warn' | 'success'; dashed?: boolean; flip?: boolean }) {
  const c = tone === 'warn' ? 'var(--color-warn)' : 'var(--color-success)'
  return (
    <svg aria-hidden className={`h-3 w-full ${flip ? 'rotate-180' : ''}`} viewBox="0 0 56 12" preserveAspectRatio="none">
      <line x1="2" y1="6" x2="45" y2="6" stroke={c} strokeWidth="1.5" strokeDasharray={dashed ? '4 4' : undefined} />
      <path d="M44,1.5 L54,6 L44,10.5 z" fill={c} />
    </svg>
  )
}

function RoleCaption({
  name,
  line,
  tone,
  stage,
  icon,
}: {
  name: string
  line: string
  tone: RoleTone
  stage: number
  icon: React.ReactNode
}) {
  return (
    <div className="lpb-stage -m-2 min-w-0 rounded-control p-2" style={stageStyle(stage, tone)}>
      <div className="flex items-center gap-2">
        <RoleBadge tone={tone}>{icon}</RoleBadge>
        <span className="text-meta font-semibold text-display">{name}</span>
      </div>
      <p className="mt-1.5 text-caption leading-snug text-secondary">{line}</p>
    </div>
  )
}

/** Compute-per-run over a loop's lifetime (the concept doc's curve, on app
 *  tokens): born agentic and expensive while it learns the pattern, graduates
 *  to a cheap deterministic script, and the agent only spikes back awake when
 *  a tripwire trips or a scheduled re-audit comes due. */
function CostCurve() {
  return (
    <svg
      viewBox="0 0 980 372"
      width="100%"
      className="mx-auto block max-w-[880px]"
      role="img"
      aria-label="Compute per run over a loop's lifetime: high while born agentic, flat after graduating to a cheap script, spiking briefly when a tripwire trips and at a scheduled re-audit"
    >
      <defs>
        <linearGradient id="lp-cc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-rubik-orange)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--color-rubik-orange)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* axes */}
      <line x1="70" y1="40" x2="70" y2="312" stroke="var(--color-wire)" strokeWidth="1.2" />
      <line x1="70" y1="312" x2="912" y2="312" stroke="var(--color-wire)" strokeWidth="1.2" />
      <text x="70" y="26" fontFamily="var(--font-mono)" fontSize="12" fill="var(--color-secondary)">
        compute / run
      </text>
      <text x="912" y="340" textAnchor="end" fontFamily="var(--font-mono)" fontSize="12" fill="var(--color-secondary)">
        loop lifetime →
      </text>
      {/* area + curve */}
      <path
        d="M70,72 C150,66 210,96 260,160 C300,210 330,256 372,262 L520,262 C544,262 560,108 580,104 C600,100 620,254 648,262 L772,262 C786,262 796,176 810,173 C824,170 836,256 854,262 L912,262 L912,312 L70,312 Z"
        fill="url(#lp-cc-fill)"
      />
      <path
        d="M70,72 C150,66 210,96 260,160 C300,210 330,256 372,262 L520,262 C544,262 560,108 580,104 C600,100 620,254 648,262 L772,262 C786,262 796,176 810,173 C824,170 836,256 854,262 L912,262"
        fill="none"
        stroke="var(--color-warn)"
        strokeWidth="2.4"
      />
      {/* phase labels */}
      <g fontFamily="var(--font-mono)">
        <text x="150" y="58" fontSize="13" fontWeight="600" fill="var(--color-display)">
          Born agentic
        </text>
        <text x="150" y="76" fontSize="11.5" fill="var(--color-secondary)">
          learns the pattern
        </text>
        <line x1="372" y1="262" x2="372" y2="300" stroke="var(--color-success)" strokeWidth="1.2" strokeDasharray="4 4" />
        <text x="430" y="292" textAnchor="middle" fontSize="12.5" fontWeight="600" fill="var(--color-success)">
          Graduates → cheap script
        </text>
        <circle cx="580" cy="104" r="4" fill="var(--color-warn)" />
        <text x="580" y="92" textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--color-warn)">
          tripwire trips
        </text>
        <text x="580" y="76" textAnchor="middle" fontSize="11" fill="var(--color-secondary)">
          agent re-wakes
        </text>
        <circle cx="810" cy="173" r="4" fill="var(--color-rubik-yellow)" />
        <text x="812" y="158" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--color-running)">
          scheduled re-audit
        </text>
      </g>
    </svg>
  )
}

/* The exec runs the evolve animation logs before the evolve pass fires - the
 * same block/outcome language as the real Timeline component (lib/format.ts
 * ST), scaled up so the story reads from across the room. Each run carries a
 * one-line note (dummy data in the shape of real runs) that the narration
 * line shows as its block lands. */
const EVOLVE_RUNS = [
  { c: 'var(--color-success)', status: 'resolved', note: 'fixed the null-team crash, PR #1027 + video proof' },
  { c: 'var(--color-secondary)', status: 'no update', note: 'docs still match the code, clean stop ($0.03)' },
  { c: 'var(--color-success)', status: 'resolved', note: '4 tickets answered, export-friction signal filed' },
  { c: 'var(--color-accent)', status: 'error', note: 'verify failed on a flaky selector, lesson saved to state' },
  { c: 'var(--color-success)', status: 'resolved', note: '2 dependency patches tested in a worktree, merged' },
  { c: 'var(--color-success)', status: 'resolved', note: 'worst prod error root-caused, fingerprint now watched' },
]

/* What the evolve pass ships, in the order the animation reveals them. */
const EVOLVE_OUTPUTS = [
  '📜 contract sharpened',
  '🚧 boundaries redrawn',
  '⚙️ repeated steps → script',
  '⏰ trigger re-tuned',
  '📊 dashboard updated',
]

/**
 * The evolve story as a live timeline in the product's own run-block UI,
 * sized up: exec runs land block by block, each with a one-line note of what
 * happened; the evolve run (the product's blue) reads the whole history with
 * a reverse ripple, ships its changes as chips, and the next hollow dot is
 * already scheduled. An ~18s tick cycle drives it; prefers-reduced-motion
 * renders the finished state statically.
 */
function EvolveTimeline() {
  // 0 blank · 1-6 runs land · 7 evolve · 8 read-back ripple · 9-13 chips ·
  // 14 next-dot + closing line. Plays ONCE when scrolled into view, then
  // stops; the replay button runs it again. Reduced motion renders the
  // finished state statically.
  const FINAL = 14
  const [tick, setTick] = useState(0)
  const [reduce, setReduce] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const play = () => {
    if (timer.current) clearInterval(timer.current)
    setTick(0)
    timer.current = setInterval(() => {
      setTick((v) => Math.min(v + 1, FINAL))
    }, 500)
  }

  // Stop the play interval once the counter reaches the final step. This lives in
  // an effect, not inside the setTick updater, so the updater stays pure — React
  // may invoke an updater more than once, so the clearInterval side effect must
  // not run from within it.
  useEffect(() => {
    if (tick >= FINAL && timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }, [tick])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setReduce(true)
      return
    }
    const el = ref.current
    if (!el) return
    // Start on first scroll-into-view, once.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          play()
        }
      },
      { threshold: 0.35 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  const at = (n: number) => reduce || tick >= n
  const scanning = !reduce && tick === 8
  const activeRun = !reduce && tick >= 1 && tick <= 6 ? tick - 1 : -1
  const done = reduce || tick >= FINAL

  // One narration line under the strip: the landing run's note, then evolve's.
  const line = reduce
    ? { c: 'var(--color-success)', head: '', text: 'the next run starts one step smarter, and cheaper' }
    : tick === 0
      ? { c: 'var(--color-wire)', head: '', text: 'a loop, run by run…' }
      : tick <= 6
        ? { c: EVOLVE_RUNS[tick - 1]!.c, head: EVOLVE_RUNS[tick - 1]!.status, text: EVOLVE_RUNS[tick - 1]!.note }
        : tick <= 8
          ? { c: 'var(--color-interactive)', head: 'evolve', text: 'reading all six runs: where was money wasted? which boundary is too loose?' }
          : tick <= 13
            ? { c: 'var(--color-interactive)', head: 'evolve', text: 'rewriting the loop itself:' }
            : { c: 'var(--color-success)', head: '', text: 'the next run starts one step smarter, and cheaper' }

  return (
    <div ref={ref} className="relative py-2">
      {/* replay - reserved in the corner so it never shifts the layout */}
      <button
        type="button"
        onClick={play}
        tabIndex={done && !reduce ? 0 : -1}
        aria-hidden={!(done && !reduce)}
        className={`absolute -top-1 right-0 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-hairline px-3 py-1 font-mono text-caption text-secondary transition-opacity duration-300 hover:bg-raised hover:text-display ${
          done && !reduce ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <span aria-hidden>↺</span> replay
      </button>

      {/* the strip (padded inside the scroll box so the active ring never clips) */}
      <div className="-mx-2 flex min-w-0 items-center justify-center gap-2 overflow-x-auto px-2 py-2">
        {EVOLVE_RUNS.map((r, i) => (
          <span
            key={i}
            title={`${r.status} · ${r.note}`}
            className={`h-10 w-9 shrink-0 rounded-[7px] transition-all duration-300 ${
              at(i + 1) ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
            }`}
            style={{
              background: r.c,
              boxShadow:
                activeRun === i
                  ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${r.c}`
                  : scanning
                    ? '0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-interactive)'
                    : undefined,
              transitionDelay: scanning ? `${(EVOLVE_RUNS.length - 1 - i) * 70}ms` : '0ms',
            }}
          />
        ))}
        <span
          aria-hidden
          className={`w-8 shrink-0 border-t-2 border-dashed border-wire transition-opacity duration-300 ${
            at(7) ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <span
          className={`flex h-10 shrink-0 items-center rounded-[7px] bg-interactive px-3.5 font-mono text-label font-medium text-white transition-all duration-300 ${
            at(7) ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
          } ${scanning ? 'animate-pulse' : ''}`}
        >
          evolve
        </span>
        {/* the loop carries on, next run already scheduled */}
        <span
          aria-hidden
          className={`flex shrink-0 items-center gap-2.5 transition-opacity duration-500 ${at(14) ? 'opacity-100' : 'opacity-0'}`}
        >
          <span className="w-10 border-t-2 border-dashed border-wire" />
          <span className="size-[15px] rounded-full border-2 border-wire" />
        </span>
      </div>

      {/* narration: what the landing block actually did (dummy data) */}
      <div className="mt-4 flex h-6 min-w-0 items-center justify-center gap-2">
        <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] transition-colors duration-300" style={{ background: line.c }} />
        <span className="truncate font-mono text-label text-primary">
          {line.head && <span className="font-medium" style={{ color: line.c }}>{line.head} · </span>}
          {line.text}
        </span>
      </div>

      {/* what evolve ships */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {EVOLVE_OUTPUTS.map((o, i) => (
          <span
            key={o}
            className={`rounded-full border border-interactive/40 bg-interactive-soft px-3 py-1.5 font-mono text-caption text-interactive transition-all duration-300 ${
              at(9 + i) ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0'
            }`}
          >
            {o}
          </span>
        ))}
      </div>
      <div
        className={`mt-4 text-center font-mono text-caption text-disabled transition-opacity duration-500 ${at(14) ? 'opacity-100' : 'opacity-0'}`}
      >
        next run, one step smarter
      </div>
    </div>
  )
}

function BuiltIn({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-body text-paper/85">
      <span aria-hidden className="mt-px shrink-0 text-rubik-green">
        ✓
      </span>
      <span>{children}</span>
    </li>
  )
}
