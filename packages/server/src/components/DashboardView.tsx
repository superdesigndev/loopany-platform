import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Tooltip } from '@base-ui/react/tooltip'
import { listJobs, listMyTeams } from '../server/loopApi'
import { listMachines } from '../server/machineFns'
import type { JobSummary, MachineSummary, RunSummary, TeamsView, TemplateInfo } from '../types'
import { isCompleted } from '../lib/format'
import { LoopCard } from './LoopCard'
import { TeamSwitcher } from './TeamSwitcher'
import { MachinesModal } from './MachinesModal'
import { NotificationsModal } from './NotificationsModal'
import { TeamsModal } from './TeamsModal'
import { ComposeModal } from './ComposeModal'
import { LoopLogo } from './LoopLogo'
import { LoopPlaybook } from './LoopPlaybook'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'

/** The seed the route loader hands the dashboard: the live fan-out plus the
 *  static-per-deploy templates. Both `/` (open mode) and `/t/<id>` render from it. */
export interface DashboardData {
  jobs: JobSummary[]
  templates: TemplateInfo[]
  machines: MachineSummary[]
  teams: TeamsView | undefined
}

/** The LIVE data fan-out - jobs/machines/teams change between polls. Templates
 *  are static per deploy (a compile-time registry), so only the route loader
 *  fetches them; the poll must not re-ship the thumb SVGs every 3-10s.
 *
 *  `teamId` (the `/t/<id>` route's team, in id form or undefined in open mode)
 *  scopes every list fn EXPLICITLY - so a tab on /t/A and one on /t/B show
 *  different teams simultaneously, independent of the shared last-used cookie. */
export async function fetchLiveData(teamId?: string) {
  const [jobs, machines, teams] = await Promise.all([
    listJobs({ data: teamId }),
    listMachines({ data: teamId }),
    listMyTeams({ data: teamId }),
  ])
  return { jobs, machines, teams }
}

/**
 * The dashboard body, shared by the `/` (open mode) and `/t/<teamId>` routes. It
 * renders from its own fetch-then-set poll state, seeded once from the route
 * loader's data, and scopes every fetch to `teamId` so the view is pinned to the
 * URL's team (multi-tab safe). The route mounts it with `key={teamId}` so a
 * team switch (a `/t/<id>` navigation) re-seeds state from the new loader data.
 */
export function DashboardView({ teamId, initial }: { teamId?: string; initial: DashboardData }) {
  // Loader data seeds the page; the poll refreshes via fetch-then-set below
  // (never router.invalidate — a loader re-run throws the whole page on a blip),
  // so this state is the single source the page renders from.
  const [data, setData] = useState(() => ({
    jobs: initial?.jobs ?? [],
    templates: initial?.templates ?? [],
    machines: initial?.machines ?? [],
    teams: initial?.teams,
  }))
  const { jobs, templates, machines, teams } = data
  const online = machines.filter((m) => m.online).length
  const navigate = useNavigate()
  // Compose carries an optional template: null = blank New Loop; a TemplateInfo =
  // a canned intent picked from the cards (ComposeModal appends its description).
  const [compose, setCompose] = useState<{ open: boolean; template: TemplateInfo | null }>({
    open: false,
    template: null,
  })
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [teamsOpen, setTeamsOpen] = useState(false)

  // Silent background refresh — fetch-then-set (like the detail pages), NOT
  // router.invalidate: invalidate re-runs the loader, whose Promise.all THROWS
  // on any rejection, swapping the whole dashboard for the error screen and
  // killing this interval (it never self-heals). A transient blip here just
  // keeps the stale data on screen; the next tick retries.
  const refetch = useCallback(async () => {
    try {
      const live = await fetchLiveData(teamId)
      // Keep the loader's templates - static per deploy, never re-polled.
      setData((prev) => ({ ...prev, ...live }))
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [teamId])

  // Poll, but never while a modal is open (avoid disrupting a compose in
  // progress). A ref keeps the interval reading current state. Speed up to 3s
  // while any loop is executing so its run block + Running badge surface (and
  // settle into a finished block) without a manual refresh.
  const openRef = useRef(false)
  openRef.current = compose.open || machinesOpen || notifyOpen || teamsOpen
  const anyRunning = jobs.some((j) => j.running)
  useEffect(() => {
    const t = setInterval(
      () => {
        if (!openRef.current) void refetch()
      },
      anyRunning ? 3_000 : 10_000,
    )
    return () => clearInterval(t)
  }, [refetch, anyRunning])

  const refresh = () => void refetch()
  const completed = jobs.filter(isCompleted)
  const active = jobs.filter((j) => !isCompleted(j))
  const activeOn = active.filter((j) => j.enabled).length

  const cardProps = () => ({
    onOpen: (id: string) => void navigate({ to: '/loops/$loopId', params: { loopId: id } }),
    onPickRun: (jobId: string, run: RunSummary) =>
      void navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: jobId, runId: run.id } }),
  })

  return (
    <Tooltip.Provider delay={120}>
      {/* Sticky glass top bar - the ONE always-glass surface; content scrolls
          beneath it so the material actually refracts something. */}
      <header className="glass glass-bar sticky top-0 z-50">
        <div className="mx-auto flex max-w-[1180px] items-center gap-3 px-8 py-2.5">
          <LoopLogo size={30} />
          <span className="text-[18px] font-semibold tracking-[-0.015em] text-display">adScaile</span>
          <TeamSwitcher data={teams} />
          <div className="flex-1" />
          {/* Open-source + community, quiet icon pills */}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository" title="GitHub" className={headerIconBtn}>
            <GitHubIcon className="size-[17px]" />
          </a>
          <a href={DISCORD_URL} target="_blank" rel="noreferrer" aria-label="Discord community" title="Discord" className={headerIconBtn}>
            <DiscordIcon className="size-[17px]" />
          </a>
          {/* Team management is a gated feature (real identities) — the button
              shows only when the user actually has teams (gate on). */}
          {teams && teams.teams.length > 0 && (
            <button onClick={() => setTeamsOpen(true)} className={headerBtn}>
              Teams
            </button>
          )}
          <button onClick={() => setNotifyOpen(true)} className={headerBtn}>
            Notifications
          </button>
          <button onClick={() => setMachinesOpen(true)} className={`${headerBtn} gap-1.5`}>
            <span className={`inline-block size-1.5 rounded-full ${online ? 'bg-rubik-green' : 'bg-disabled'}`} />
            {online} {online === 1 ? 'machine' : 'machines'} online
          </button>
          <button
            onClick={() => setCompose({ open: true, template: null })}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-full bg-display px-3.5 py-1.5 text-meta font-medium text-paper transition-opacity hover:opacity-85"
          >
            New Loop
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-8 pb-24">
        {/* Hero - invite creation first (serif = the one editorial moment),
            then the template fan, then a prominent blank-loop entry. */}
        <section className="pb-2 pt-14 text-center">
          <h1 className="font-pixel text-[clamp(28px,4.5vw,38px)] leading-[1.15] text-display">
            What should happen while you sleep?
          </h1>
          {templates.length > 0 && (
            <>
              <div className="mb-5 mt-2 text-body text-secondary">Start with a template…</div>
              <TemplateFan templates={templates} onPick={(t) => setCompose({ open: true, template: t })} />
            </>
          )}
          <div className="mt-7">
            <button
              onClick={() => setCompose({ open: true, template: null })}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-display px-6 py-2.5 text-body font-medium text-paper transition-opacity hover:opacity-85"
            >
              {templates.length ? 'Start a blank loop' : 'Start your first loop'}
              <span aria-hidden>→</span>
            </button>
          </div>
        </section>

        <div className="mb-5 mt-12 flex items-baseline gap-2.5">
          <h2 className="text-body font-semibold text-display">Active loops</h2>
          <span className="text-label text-secondary">
            {active.length ? `${activeOn} scheduled · ${active.length} total` : ''}
          </span>
        </div>

        {active.length ? (
          active.map((j) => <LoopCard job={j} {...cardProps()} key={j.id} />)
        ) : (
          <div className="py-16 text-center">
            <div className="text-[15px] text-secondary">
              {jobs.length ? 'No active loops' : 'No loops yet'}
            </div>
            {!jobs.length && (
              <div className="mt-1.5 text-body text-disabled">
                Pick a template above, or start a blank loop.
              </div>
            )}
          </div>
        )}

        {completed.length > 0 && (
          <>
            <div className="mb-5 mt-11 flex items-baseline gap-2.5">
              <h2 className="text-body font-semibold text-display">Completed</h2>
              <span className="text-label text-secondary">{completed.length} total</span>
            </div>
            {completed.map((j) => (
              <LoopCard job={j} {...cardProps()} key={j.id} />
            ))}
          </>
        )}

        {/* The playbook band - static education/sales content anchoring the page;
            its CTA is the same blank-loop compose as the hero button. */}
        <LoopPlaybook onStart={() => setCompose({ open: true, template: null })} />
      </main>

      <ComposeModal
        open={compose.open}
        template={compose.template}
        teamId={teamId}
        onClose={() => setCompose({ open: false, template: null })}
        onCreated={refresh}
      />

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} teamId={teamId} />

      <NotificationsModal open={notifyOpen} onClose={() => setNotifyOpen(false)} />

      <TeamsModal open={teamsOpen} onClose={() => setTeamsOpen(false)} activeTeamId={teamId} />
    </Tooltip.Provider>
  )
}

/* The top bar's quiet pill button (Notifications / Machines share it). */
const headerBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full px-3 py-1.5 text-meta font-medium text-secondary transition-colors hover:bg-raised hover:text-display'

/* Icon-only variant for the GitHub/Discord links. */
const headerIconBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full p-1.5 text-secondary transition-colors hover:bg-raised hover:text-display'

/**
 * The template fan - a hand of tilted cards (tilt/lift computed from each
 * card's offset from its ROW's center). Up to 5 cards stay a single hand;
 * more split into balanced rows of at most 4 (7 -> 4/3, 9 -> 3/3/3), so no
 * count can flex-wrap into one orphan card stranded under a full row.
 * Hover/focus straightens a card via the `.fan-card` rules in app.css.
 * One click carries the template into ComposeModal, same as the old flat cards.
 */
function TemplateFan({
  templates,
  onPick,
}: {
  templates: TemplateInfo[]
  onPick: (t: TemplateInfo) => void
}) {
  const rowCount = templates.length <= 5 ? 1 : Math.ceil(templates.length / 4)
  const rows: TemplateInfo[][] = []
  for (let r = 0, at = 0; r < rowCount; r++) {
    const size = Math.ceil((templates.length - at) / (rowCount - r))
    rows.push(templates.slice(at, at + size))
    at += size
  }
  return (
    <div className="pb-3 pt-1">
      {rows.map((row, r) => {
        const center = (row.length - 1) / 2
        return (
          <div key={r} className="flex flex-wrap items-start justify-center">
            {row.map((t, i) => {
              const off = i - center
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => onPick(t)}
                  title={t.desc}
                  className="fan-card relative w-[196px] shrink-0 cursor-pointer rounded-card border border-hairline bg-surface p-3 text-left shadow-[0_12px_28px_-16px_rgba(0,0,0,0.25)] outline-none focus-visible:ring-2 focus-visible:ring-interactive"
                  style={
                    {
                      '--tilt': `${off * 3.5}deg`,
                      '--lift': `${Math.abs(off) * 7}px`,
                      marginInline: row.length > 1 ? '-5px' : undefined,
                    } as React.CSSProperties
                  }
                >
                  {t.thumb ? (
                    // The preview is a repo-authored thumb.svg inlined by the registry
                    // (trusted content, same trust boundary as the skill markdown);
                    // inline so it inherits the theme's CSS variables.
                    <span
                      className="block overflow-hidden rounded-control bg-raised [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
                      dangerouslySetInnerHTML={{ __html: t.thumb }}
                    />
                  ) : (
                    // Fallback for a template folder that ships no thumb.svg yet.
                    <span className="flex h-[76px] items-center justify-center rounded-control bg-raised text-secondary">
                      <LoopGlyph />
                    </span>
                  )}
                  <span className="mt-2.5 block truncate text-center text-meta font-semibold text-primary">{t.label}</span>
                  {/* Fixed three-line well (clamp + min-h) so every card in the fan is
                      the same height regardless of how chatty a template's desc is -
                      the full text lives in the hover title + the compose modal.
                      NOTE: no `block` here - display:block would override the
                      -webkit-box that line-clamp needs. */}
                  <span className="mt-0.5 line-clamp-3 min-h-[45px] text-center text-caption leading-snug text-secondary">
                    {t.desc}
                  </span>
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** A circular-arrow "loop" mark - one glyph for every template, tinted per card. */
function LoopGlyph() {
  return (
    <svg
      aria-hidden
      width="30"
      height="30"
      viewBox="0 0 30 30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M25.5 15a10.5 10.5 0 1 1-3.1-7.4" />
      <path d="M25.5 3.5v5.2h-5.2" />
    </svg>
  )
}
