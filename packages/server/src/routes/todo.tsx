import { createFileRoute, redirect } from '@tanstack/react-router'

import { getAuthState, getDefaultTeam } from '../server/loopApi'
import { authClient } from '../lib/auth-client'
import { TodoPage } from '../components/TeamTodoView'
import { SignIn } from '../components/SignIn'

/**
 * The OPEN-MODE To-Do board (`/todo`). Mirrors `/timeline`: with the gate on this
 * is a thin redirect to the explicit team URL (`/t/<id>/todo`) so the team lives
 * in the path; with the gate off the single shared workspace renders here. Without
 * this route the view would be unreachable in open mode (the header link needs a
 * `teamId` to build `/t/$teamId/todo`, and open mode has none).
 */
export const Route = createFileRoute('/todo')({
  ssr: false,
  loader: async (): Promise<{ mode: 'signin' | 'todo' }> => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { mode: 'signin' }
      const teamId = await getDefaultTeam()
      throw redirect({ to: '/t/$teamId/todo', params: { teamId } })
    }
    return { mode: 'todo' }
  },
  component: OpenTodo,
})

function OpenTodo() {
  const loaded = Route.useLoaderData()
  if (loaded?.mode === 'signin') return <SignIn />
  return <TodoPage />
}
