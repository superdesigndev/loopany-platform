import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { Tooltip } from '@base-ui/react/tooltip'
import { getAuthState, listJobs, listMyTeams, listTemplates } from '../server/loopApi'
import { listMachines } from '../server/machineFns'
import { authClient, useSession } from '../lib/auth-client'
import type { RunSummary, TemplateInfo } from '../types'
import { isCompleted } from '../lib/format'
import { LoopCard } from '../components/LoopCard'
import { TeamSwitcher } from '../components/TeamSwitcher'
import { MachinesModal } from '../components/MachinesModal'
import { NotificationsModal } from '../components/NotificationsModal'
import { ComposeModal } from '../components/ComposeModal'
import { LoopLogo } from '../components/LoopLogo'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'

/** The dashboard's data fan-out — ONE definition shared by the route loader
 *  (which throws through it into the errorComponent) and the in-page refetch
 *  (which catches and keeps stale data). */
async function fetchDashboardData() {
  const [jobs, templates, machines, teams] = await Promise.all([
    listJobs(),
    listTemplates(),
    listMachines(),
    listMyTeams(),
  ])
  return { jobs, templates, machines, teams }
}

export const Route = createFileRoute('/')({
  ssr: false,
  loader: async () => {
    const auth = await getAuthState()
    // Skip the data fetch only while the visitor is unauthenticated (the sign-in
    // CTA renders then). Once signed in, fetch — the loader (ssr:false) runs in
    // the browser so the session cookie rides along. Without the session check
    // here, the gate would leave the dashboard permanently empty after sign-in.
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { jobs: [], templates: [], machines: [], teams: undefined, auth }
    }
    return { ...(await fetchDashboardData()), auth }
  },
  component: Gate,
  errorComponent: LoadError,
})

/** First-load failure screen — a calm retry instead of the router's default
 *  error dump. Only the initial loader can land here; the in-page poll is
 *  fetch-then-set and keeps stale data on a transient blip. */
function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't load the dashboard." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

/** Auth gate (only when a GitHub OAuth app is configured; otherwise open). Keeps
 *  Dashboard's hooks isolated so the gate never changes hook order. */
function Gate() {
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  if (auth?.enabled && !isPending && !session) return <SignIn />
  return <Dashboard />
}

function Dashboard() {
  const initial = Route.useLoaderData()
  // Loader data seeds the page; the poll refreshes via fetch-then-set below
  // (never router.invalidate — see the poll comment), so this state is the
  // single source the page renders from.
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

  // Silent background refresh — fetch-then-set (like the detail pages), NOT
  // router.invalidate: invalidate re-runs the loader, whose Promise.all THROWS
  // on any rejection, swapping the whole dashboard for the error screen and
  // killing this interval (it never self-heals). A transient blip here just
  // keeps the stale data on screen; the next tick retries.
  const refetch = useCallback(async () => {
    try {
      setData(await fetchDashboardData())
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [])

  // Poll, but never while a modal is open (avoid disrupting a compose in
  // progress). A ref keeps the interval reading current state. Speed up to 3s
  // while any loop is executing so its run block + Running badge surface (and
  // settle into a finished block) without a manual refresh.
  const openRef = useRef(false)
  openRef.current = compose.open || machinesOpen || notifyOpen
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
      <main className="mx-auto max-w-[1180px] px-8 pb-24 pt-12">
        <header className="mb-9 flex items-start justify-between gap-4">
          <div className="flex items-center gap-8">
            <LoopLogo size={52} />
            <div>
              <div className="mb-2 font-mono text-[11px] tracking-[0.28em] text-secondary">
                Scheduled Agent Loops
              </div>
              <h1 className="font-display text-[52px] font-medium leading-none tracking-tight text-display">
                Loopany
              </h1>
            </div>
          </div>
          <div className="mt-1 flex shrink-0 items-center gap-2">
            <TeamSwitcher data={teams} onSwitch={refresh} />
            <button
              onClick={() => setNotifyOpen(true)}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-wire bg-surface px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display"
            >
              Notifications
            </button>
            <button
              onClick={() => setMachinesOpen(true)}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-wire bg-surface px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display"
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${online ? 'bg-[color:var(--color-ok,#16a34a)]' : 'bg-disabled'}`}
              />
              {online} {online === 1 ? 'Machine' : 'Machines'} Online
            </button>
          </div>
        </header>

        {/* toolbar: New Loop + template cases (canned intents) rendered beside it —
            one click on a card goes straight to its snippet. */}
        <div className="flex flex-wrap items-stretch gap-3">
          <button
            onClick={() => setCompose({ open: true, template: null })}
            className="flex w-40 cursor-pointer flex-col justify-center gap-1.5 rounded-lg bg-display px-5 py-4 text-paper transition-opacity hover:opacity-80"
          >
            <span className="font-display text-2xl leading-none">+</span>
            <span className="font-mono text-[12px] tracking-[0.08em]">New Loop</span>
          </button>
          {templates.map((t) => (
            <button
              key={t.name}
              onClick={() => setCompose({ open: true, template: t })}
              className="flex min-w-0 max-w-72 flex-1 cursor-pointer flex-col justify-center gap-1 rounded-lg border border-wire bg-surface px-5 py-4 text-left transition-colors hover:border-display"
            >
              <span className="text-[14px] font-medium text-display">{t.label}</span>
              <span className="text-[12.5px] leading-snug text-secondary">{t.desc}</span>
            </button>
          ))}
        </div>

        <div className="my-8 h-px bg-hairline" />

        <div className="mb-5 flex items-baseline gap-3">
          <span className="font-mono text-[12px] tracking-[0.12em] text-display">
            Active Loops
          </span>
          <span className="font-mono text-[11px] tracking-[0.04em] text-secondary">
            {active.length ? `${activeOn} SCHEDULED · ${active.length} TOTAL` : ''}
          </span>
        </div>

        {active.length ? (
          active.map((j) => <LoopCard key={j.id} job={j} {...cardProps()} />)
        ) : (
          <div className="py-16 text-center">
            <div className="text-[15px] text-secondary">
              {jobs.length ? 'No active loops' : 'No loops yet'}
            </div>
            {!jobs.length && (
              <div className="mt-1.5 text-[13px] text-disabled">
                Click New Loop or a template to start.
              </div>
            )}
          </div>
        )}

        {completed.length > 0 && (
          <>
            <div className="mb-5 mt-11 flex items-baseline gap-3">
              <span className="font-mono text-[12px] tracking-[0.12em] text-display">
                Completed
              </span>
              <span className="font-mono text-[11px] tracking-[0.04em] text-secondary">
                {completed.length} COMPLETED
              </span>
            </div>
            {completed.map((j) => (
              <LoopCard key={j.id} job={j} {...cardProps()} />
            ))}
          </>
        )}
      </main>

      <ComposeModal
        open={compose.open}
        template={compose.template}
        onClose={() => setCompose({ open: false, template: null })}
        onCreated={refresh}
      />

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} />

      <NotificationsModal open={notifyOpen} onClose={() => setNotifyOpen(false)} />
    </Tooltip.Provider>
  )
}
