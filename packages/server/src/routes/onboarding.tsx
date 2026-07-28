import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { canViewTeam, getAuthState, getDefaultTeam, listTemplates } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import type { TemplateInfo } from '../types'
import { OnboardingWizard } from '../components/OnboardingWizard'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'

/**
 * The first-run onboarding wizard, its OWN route (`/onboarding`) rather than a
 * homepage overlay — deliberately, so it never has to restructure the dashboard
 * (two other crews are reworking that surface). The homepage adds only a minimal
 * entry hook that navigates here.
 *
 * Under the auth gate it binds to a team (so the minted machine + claim land in the
 * right one) and shows the sign-in CTA when signed out. The team comes from the
 * `?team=` search param when the entry point knows it — the dashboard the banner was
 * shown on — because the cookie-backed default can point at a DIFFERENT team on a
 * bookmarked/shared `/t/<id>`. A team the caller can't view is ignored (never trusted
 * from the URL), falling back to the default. Open mode renders with no team segment.
 */
export const Route = createFileRoute('/onboarding')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { team?: string } => {
    const team = typeof search.team === 'string' ? search.team.trim() : ''
    return team ? { team } : {}
  },
  loaderDeps: ({ search }) => ({ team: search.team }),
  loader: async ({
    deps,
  }): Promise<{
    mode: 'signin' | 'wizard'
    auth: { enabled: boolean }
    teamId?: string
    housekeeper: TemplateInfo | null
  }> => {
    const auth = await getAuthState()
    const housekeeper = (await listTemplates()).find((t) => t.name === 'housekeeper') ?? null
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { mode: 'signin', auth, housekeeper }
      const requested = deps.team
      const teamId = requested && (await canViewTeam({ data: requested })) ? requested : await getDefaultTeam()
      return { mode: 'wizard', auth, teamId, housekeeper }
    }
    return { mode: 'wizard', auth, housekeeper }
  },
  component: Onboarding,
  errorComponent: LoadError,
})

function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-xl px-8 pt-12">
      <LoadErrorCard title="Couldn't start onboarding." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function Onboarding() {
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  const navigate = useNavigate()

  if (loaded?.auth?.enabled && !isPending && !session) return <SignIn />
  if (loaded?.mode === 'signin') return <SignIn />

  const exit = () => {
    if (loaded.teamId) void navigate({ to: '/t/$teamId', params: { teamId: loaded.teamId } })
    else void navigate({ to: '/' })
  }

  // The payoff hand-off: into the created loop's first run (or its Loop page).
  const seeResult = (loopId: string, runId?: string) => {
    if (runId) void navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId, runId } })
    else void navigate({ to: '/loops/$loopId', params: { loopId } })
  }

  return <OnboardingWizard teamId={loaded.teamId} housekeeper={loaded.housekeeper} onExit={exit} onSeeResult={seeResult} />
}
