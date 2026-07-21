import { createFileRoute, redirect } from '@tanstack/react-router'

import { getAuthState, getDefaultTeam } from '../server/loopApi'
import { authClient } from '../lib/auth-client'
import { TimelinePage } from '../components/LoopTimeline'
import { SignIn } from '../components/SignIn'

/**
 * The OPEN-MODE timeline (`/timeline`). Mirrors how `/` works: with the gate on
 * this is a thin redirect to the explicit team URL (`/t/<id>/timeline`) so the
 * team lives in the path; with the gate off there is no team segment to use, and
 * the single shared workspace renders right here.
 *
 * Without this route the view would be unreachable in open mode — the header link
 * needs a `teamId` to build `/t/$teamId/timeline`, and open mode has none.
 */
export const Route = createFileRoute('/timeline')({
  ssr: false,
  loader: async (): Promise<{ mode: 'signin' | 'timeline' }> => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { mode: 'signin' }
      const teamId = await getDefaultTeam()
      throw redirect({ to: '/t/$teamId/timeline', params: { teamId } })
    }
    return { mode: 'timeline' }
  },
  component: OpenTimeline,
})

function OpenTimeline() {
  const loaded = Route.useLoaderData()
  if (loaded?.mode === 'signin') return <SignIn />
  return <TimelinePage />
}
