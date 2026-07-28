import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { canViewTeam, getAuthState, listBundles } from '../server/loopApi'
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
  // `?template=<name>` is forwarded from `/` (the public-market deep link) and preselects
  // the compose modal on this team's dashboard.
  validateSearch: (s: Record<string, unknown>): { template?: string } => ({
    template: typeof s.template === 'string' && s.template ? s.template : undefined,
  }),
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
    // Bundles already embed every TemplateInfo, so the registry ships ONCE.
    const [live, bundles] = await Promise.all([fetchLiveData(teamId), listBundles()])
    const initial = { ...live, bundles }
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
  const { template } = Route.useSearch()
  const { data: session, isPending } = useSession()
  // Keep the deep-linked template through the OAuth round-trip back to this team URL.
  const callbackURL = `/t/${loaded!.teamId}${template ? `?template=${encodeURIComponent(template)}` : ''}`
  if (loaded?.auth?.enabled && !isPending && !session) return <SignIn callbackURL={callbackURL} />
  if (loaded?.mode === 'signin') return <SignIn callbackURL={callbackURL} />
  // key={teamId} re-seeds DashboardView's fetch-then-set state when the switcher
  // navigates from /t/A to /t/B (same route, new param ⇒ no natural remount).
  return <DashboardView key={loaded!.teamId} teamId={loaded!.teamId} initial={loaded!.initial!} openTemplate={template} />
}
