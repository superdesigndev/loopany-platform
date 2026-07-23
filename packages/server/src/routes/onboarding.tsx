import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { getAuthState, getDefaultTeam, listTemplates } from '../server/loopApi'
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
 * Under the auth gate it resolves the caller's default team (so the minted machine
 * + claim bind to the right team) and shows the sign-in CTA when signed out. Open
 * mode renders the wizard with no team segment.
 */
export const Route = createFileRoute('/onboarding')({
  ssr: false,
  loader: async (): Promise<{
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
      const teamId = await getDefaultTeam()
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

  return <OnboardingWizard teamId={loaded.teamId} housekeeper={loaded.housekeeper} onExit={exit} />
}
