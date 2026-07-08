import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { canViewTeam, getAuthState, listTemplates } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import { DashboardView, fetchLiveData, type DashboardData } from '../components/DashboardView'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'

/**
 * The explicit-team dashboard (`/t/<teamId>`, Phase 2): the same dashboard scoped
 * to the team in the PATH, so a view is bookmarkable and each browser tab keeps
 * its own team (the list server fns take an explicit `teamId`, independent of the
 * shared last-used cookie). A team id rides the URL verbatim.
 *
 * The loader validates membership (`canViewTeam`) and, on failure, throws the SAME
 * generic not-found as a missing loop — never confirming a team exists to a
 * non-member (enumeration safety). Open mode has no gate: any `/t/<x>` renders the
 * single shared workspace.
 */
export const Route = createFileRoute('/t/$teamId')({
  ssr: false,
  loader: async ({
    params,
  }): Promise<{ mode: 'signin' | 'dashboard'; auth: { enabled: boolean }; teamId: string; initial?: DashboardData }> => {
    const teamId = params.teamId
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      // Signed out under the gate ⇒ the sign-in CTA (the loader runs in the browser,
      // so the session cookie rides along once signed in).
      if (!session) return { mode: 'signin', auth, teamId }
      // Enumeration-safe gate: a team the caller can't view throws the same generic
      // message as a missing loop — existence never leaks to a non-member.
      if (!(await canViewTeam({ data: teamId }))) {
        throw new Error('This team does not exist, or you do not have access to it.')
      }
    }
    const initial = { ...(await fetchLiveData(teamId)), templates: await listTemplates() }
    return { mode: 'dashboard', auth, teamId, initial }
  },
  component: TeamDashboard,
  errorComponent: LoadError,
})

/** Load-failure screen (a non-member's generic not-found, or a first-load blip).
 *  Retry re-runs the loader; harmless for the not-found case, self-heals a blip. */
function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't open this team." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function TeamDashboard() {
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  if (loaded?.auth?.enabled && !isPending && !session) return <SignIn />
  if (loaded?.mode === 'signin') return <SignIn />
  // key={teamId} re-seeds DashboardView's fetch-then-set state when the switcher
  // navigates from /t/A to /t/B (same route, new param ⇒ no natural remount).
  return <DashboardView key={loaded!.teamId} teamId={loaded!.teamId} initial={loaded!.initial!} />
}
