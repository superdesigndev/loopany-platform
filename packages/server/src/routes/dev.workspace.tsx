import { createFileRoute, notFound } from '@tanstack/react-router'

import { SignIn } from '../components/SignIn'
import { WorkspaceView } from '../components/workspace/WorkspaceView'
import { workspaceAccess, type WorkspaceAccess } from '../server/workspaceFns'
import workspaceCss from '../styles/workspace.css?url'

/**
 * `/dev/workspace` — the rewrite's workspace (landing unit 5).
 *
 * FLAGGED, and mounted exactly the way the old graph workspace was: its own
 * route, its own stylesheet loaded by `?url` (never imported into the app's
 * Tailwind sheet, and scoped under `.loopany-workspace`), and no reference from
 * anywhere in the shipping dashboard. Turning the flag off makes the route
 * simply not exist.
 *
 * `ssr: false` matches the rest of the gated app: the loader runs in the browser
 * so the session cookie rides along with the view-endpoint fetches.
 */
export const Route = createFileRoute('/dev/workspace')({
  ssr: false,
  head: () => ({
    meta: [{ title: 'Loopany — workspace' }],
    links: [{ rel: 'stylesheet', href: workspaceCss }],
  }),
  loader: async (): Promise<{ access: WorkspaceAccess }> => {
    const access = await workspaceAccess()
    // Not enabled on this server ⇒ the route simply does not exist.
    if (access.state === 'disabled') throw notFound()
    return { access }
  },
  component: WorkspacePage,
})

function WorkspacePage() {
  const { access } = Route.useLoaderData()
  if (access.state === 'signin') return <SignIn />
  return <WorkspaceView />
}
