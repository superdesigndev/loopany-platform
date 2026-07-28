import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Tooltip } from '@base-ui/react/tooltip'
import { listJobs, listMyTeams } from '../server/loopApi'
import { listMachines } from '../server/machineFns'
import type { BundleView, JobSummary, MachineSummary, RunSummary, TeamsView, TemplateInfo } from '../types'
import { isCompleted } from '../lib/format'
import { LoopCard } from './LoopCard'
import { BundleCarousel } from './BundleCarousel'
import { TeamSwitcher } from './TeamSwitcher'
import { MachinesModal } from './MachinesModal'
import { NotificationsModal } from './NotificationsModal'
import { TeamsModal } from './TeamsModal'
import { ComposeModal } from './ComposeModal'
import { OnboardingEntry } from './OnboardingEntry'
import { LoopLogo } from './LoopLogo'
import { LoopPlaybook } from './LoopPlaybook'
import { TemplatesPreview } from './TemplatesPreview'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'

/** The seed the route loader hands the dashboard: the live fan-out plus the
 *  static-per-deploy bundles. Both `/` (open mode) and `/t/<id>` render from it. */
export interface DashboardData {
  jobs: JobSummary[]
  /** Curated template groupings for the carousel. Each bundle embeds its resolved
   *  members, so this IS the template registry — seeded from the route loader only,
   *  never re-shipped on the poll (and never fetched a second time as a flat list). */
  bundles: BundleView[]
  machines: MachineSummary[]
  teams: TeamsView | undefined
}

/** The LIVE data fan-out - jobs/machines/teams change between polls. Bundles
 *  (and the templates they embed) are static per deploy (a compile-time registry),
 *  so only the route loader fetches them; the poll must not re-ship the thumb SVGs
 *  every 3-10s.
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
export function DashboardView({
  teamId,
  initial,
  openTemplate,
}: {
  teamId?: string
  initial: DashboardData
  /** A template NAME deep-linked from the public market (`/?template=<name>`): on mount
   *  the compose modal opens preselected on it, reusing the exact single-template flow
   *  the carousel uses — no parallel creation path. Ignored if it matches no template. */
  openTemplate?: string
}) {
  // Loader data seeds the page; the poll refreshes via fetch-then-set below
  // (never router.invalidate — a loader re-run throws the whole page on a blip),
  // so this state is the single source the page renders from.
  const [data, setData] = useState(() => ({
    jobs: initial?.jobs ?? [],
    bundles: initial?.bundles ?? [],
    machines: initial?.machines ?? [],
    teams: initial?.teams,
  }))
  const { jobs, bundles, machines, teams } = data
  const online = machines.filter((m) => m.online).length
  const navigate = useNavigate()
  // Compose carries an optional template OR bundle: both null = blank New Loop; a
  // TemplateInfo = a single canned intent (ComposeModal appends its description); a
  // BundleView = a whole bundle (ComposeModal builds the multi-loop candidate menu).
  // At most one of template/bundle is set.
  const [compose, setCompose] = useState<{ open: boolean; template: TemplateInfo | null; bundle: BundleView | null }>({
    open: false,
    template: null,
    bundle: null,
  })
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [teamsOpen, setTeamsOpen] = useState(false)

  // Deep-link from the public market: open the single-template compose preselected on
  // `openTemplate` once (guarded so the 3-10s poll re-render never reopens it). The
  // template object is resolved from the loader's bundles — they partition the whole
  // registry (pinned by bundles.test.ts), so it carries the same shape the carousel passes.
  const deepLinkedRef = useRef(false)
  useEffect(() => {
    if (deepLinkedRef.current || !openTemplate) return
    const t = bundles.flatMap((b) => b.members).find((x) => x.name === openTemplate)
    if (!t) return
    deepLinkedRef.current = true
    setCompose({ open: true, template: t, bundle: null })
  }, [openTemplate, bundles])

  // Silent background refresh — fetch-then-set (like the detail pages), NOT
  // router.invalidate: invalidate re-runs the loader, whose Promise.all THROWS
  // on any rejection, swapping the whole dashboard for the error screen and
  // killing this interval (it never self-heals). A transient blip here just
  // keeps the stale data on screen; the next tick retries.
  const refetch = useCallback(async () => {
    try {
      const live = await fetchLiveData(teamId)
      // Keep the loader's bundles - static per deploy, never re-polled.
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
          <span className="text-[18px] font-semibold tracking-[-0.015em] text-display">Loopany</span>
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
          {/* The cross-loop timeline is a PAGE, not a modal (it owns a zoom +
              window in its own right). Open mode has no /t/<id>, so it links to
              the bare /timeline route instead — the view must be reachable in
              BOTH modes or self-hosters never find it. */}
          {teamId ? (
            <Link to="/t/$teamId/timeline" params={{ teamId }} className={headerBtn}>
              Timeline
            </Link>
          ) : (
            <Link to="/timeline" className={headerBtn}>
              Timeline
            </Link>
          )}
          <button onClick={() => setNotifyOpen(true)} className={headerBtn}>
            Notifications
          </button>
          <button onClick={() => setMachinesOpen(true)} className={`${headerBtn} gap-1.5`}>
            <span className={`inline-block size-1.5 rounded-full ${online ? 'bg-rubik-green' : 'bg-disabled'}`} />
            {online} {online === 1 ? 'machine' : 'machines'} online
          </button>
          <button
            onClick={() => setCompose({ open: true, template: null, bundle: null })}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-full bg-display px-3.5 py-1.5 text-meta font-medium text-paper transition-opacity hover:opacity-85"
          >
            New Loop
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-8 pb-24">
        {/* Minimal first-run entry hook: auto-starts the guided onboarding for an
            empty workspace and offers a quiet re-entry while the user has no loops.
            Its own component so this dashboard body stays untouched. */}
        <div className="pt-6">
          <OnboardingEntry teamId={teamId} noLoops={jobs.length === 0} noMachines={machines.length === 0} />
        </div>
        {/* Hero - invite creation first (serif = the one editorial moment), then the
            auto-playing bundle carousel, then a prominent blank-loop entry. */}
        <section className="pb-2 pt-14 text-center">
          <h1 className="font-pixel text-[clamp(28px,4.5vw,38px)] leading-[1.15] text-display">
            What should happen while you sleep?
          </h1>
          {bundles.length > 0 && (
            <BundleCarousel
              bundles={bundles}
              onPickTemplate={(t) => setCompose({ open: true, template: t, bundle: null })}
              onTryBundle={(b) => setCompose({ open: true, template: null, bundle: b })}
            />
          )}
          <div className="mt-7">
            <button
              onClick={() => setCompose({ open: true, template: null, bundle: null })}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-display px-6 py-2.5 text-body font-medium text-paper transition-opacity hover:opacity-85"
            >
              {bundles.length ? 'Start a blank loop' : 'Start your first loop'}
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
                Pick a bundle above, or start a blank loop.
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

        {/* The catalog teaser, directly above the playbook: the market's own text-first
            cards over a round-robin subset across bundles (two full rows, the third
            fading), ending in "Browse all N templates". Reads off the loader's static
            bundles, so the poll never touches it. */}
        <TemplatesPreview bundles={bundles} />

        {/* The playbook band - static education/sales content anchoring the page;
            its CTA is the same blank-loop compose as the hero button. */}
        <LoopPlaybook onStart={() => setCompose({ open: true, template: null, bundle: null })} />
      </main>

      <ComposeModal
        open={compose.open}
        template={compose.template}
        bundle={compose.bundle}
        teamId={teamId}
        onClose={() => setCompose({ open: false, template: null, bundle: null })}
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
