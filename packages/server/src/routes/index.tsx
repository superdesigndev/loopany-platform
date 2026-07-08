import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { getAuthState, getDefaultTeam, listTemplates } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import { teamParamFromId } from '../lib/teamUrl'
import { DashboardView, fetchLiveData, type DashboardData } from '../components/DashboardView'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'

/**
 * The home route. Under the auth gate it is now a THIN redirect to the explicit
 * team URL (`/t/<lastUsed|personal>`) so the dashboard's team lives in the path
 * (bookmarkable, multi-tab). `/` keeps working forever: a signed-out visitor gets
 * the sign-in CTA; open mode (no gate ⇒ a single shared workspace with no team to
 * expose in the URL) renders the dashboard right here, unchanged.
 */
export const Route = createFileRoute('/')({
  ssr: false,
  loader: async (): Promise<{ mode: 'signin' | 'dashboard'; auth: { enabled: boolean }; initial?: DashboardData }> => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      // Signed out under the gate ⇒ render the sign-in CTA (no team to redirect to).
      if (!session) return { mode: 'signin', auth }
      // Signed in ⇒ hand off to the explicit team URL. getDefaultTeam validates the
      // last-used cookie (else the personal team) server-side; a single-team user
      // lands on their only team with zero friction.
      const teamId = await getDefaultTeam()
      throw redirect({ to: '/t/$teamId', params: { teamId: teamParamFromId(teamId) } })
    }
    // Open mode: one shared workspace, no team segment. Render the dashboard here.
    const initial = { ...(await fetchLiveData()), templates: await listTemplates() }
    return { mode: 'dashboard', auth, initial }
  },
  component: Home,
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

/** Open mode renders the dashboard; the gated signed-out case renders SignIn. The
 *  gated signed-in case never reaches here (the loader threw a redirect). */
function Home() {
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  if (loaded?.auth?.enabled && !isPending && !session) return <SignIn />
  if (loaded?.mode === 'signin') return <SignIn />
  return <DashboardView initial={loaded!.initial!} />
}
