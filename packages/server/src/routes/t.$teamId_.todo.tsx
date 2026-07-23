import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'

import { canViewTeam, getAuthState } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import { TodoPage } from '../components/TeamTodoView'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'

/**
 * The team To-Do board (`/t/<teamId>/todo`). The trailing `_` on the parent
 * segment un-nests it from `t.$teamId.tsx` (which renders the dashboard directly,
 * no `<Outlet/>`), the same trick the timeline + run-detail routes use.
 *
 * Same enumeration-safe membership gate as the dashboard: a team the caller can't
 * view throws the SAME generic not-found as a missing loop. The view fetches its
 * own data (and polls), so the loader only authorizes.
 */
export const Route = createFileRoute('/t/$teamId_/todo')({
  ssr: false,
  loader: async ({ params }): Promise<{ mode: 'signin' | 'todo'; auth: { enabled: boolean }; teamId: string }> => {
    const teamId = params.teamId
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { mode: 'signin', auth, teamId }
      if (!(await canViewTeam({ data: teamId }))) {
        throw new Error('This team does not exist, or you do not have access to it.')
      }
    }
    return { mode: 'todo', auth, teamId }
  },
  component: TeamTodo,
  errorComponent: LoadError,
})

function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't open this To-Do list." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function TeamTodo() {
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  if (loaded?.auth?.enabled && !isPending && !session) return <SignIn />
  if (loaded?.mode === 'signin') return <SignIn />
  return <TodoPage teamId={loaded!.teamId} />
}
