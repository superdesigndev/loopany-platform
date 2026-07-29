import { createFileRoute, notFound } from '@tanstack/react-router'

import { WorkspaceView } from '../components/workspace/WorkspaceView'
import { SignIn } from '../components/SignIn'
import { graphWorkspaceAccess, type GraphWorkspaceAccess } from '../server/graphWorkspaceFns'
import workspaceCss from '../styles/workspace.css?url'

/**
 * `/dev/workspace` — the Graph Engineering v1 workspace.
 *
 * GATED. The page renders REAL production content (support tickets carrying
 * customer names and emails), so outside local dev it requires a signed-in user
 * who is on the workspace allowlist — which fails closed when unset. See
 * `lib/graphWorkspace.ts` for the policy and why it is stricter than the
 * app-wide one.
 *
 * The loader decides between three screens: the app's ordinary `SignIn` when
 * signed out, a plain refusal when signed in but not allow-listed, and the
 * workspace itself. It is NOT the security boundary — `/api/graph/*` gates
 * itself independently, so even a page that rendered would have no data.
 *
 * `ssr: false` matches the rest of the gated app: the loader runs in the browser
 * so the session cookie rides along.
 *
 * The demo's stylesheet is loaded HERE via `?url` (a separate link, not an
 * import into the Tailwind sheet) and is scoped under `.loopany-workspace`, so
 * the skin cannot reach any other route.
 */
export const Route = createFileRoute('/dev/workspace')({
  ssr: false,
  head: () => ({
    meta: [{ title: 'Loopany — Graph v1 workspace' }],
    links: [{ rel: 'stylesheet', href: workspaceCss }],
  }),
  loader: async (): Promise<{ access: GraphWorkspaceAccess }> => {
    const access = await graphWorkspaceAccess()
    // Not enabled on this server ⇒ the route simply does not exist.
    if (access.state === 'disabled') throw notFound()
    return { access }
  },
  component: WorkspacePage,
})

function WorkspacePage() {
  const { access } = Route.useLoaderData()

  if (access.state === 'signin') return <SignIn />
  if (access.state === 'denied') {
    return (
      <main className="mx-auto max-w-[52rem] px-8 pt-24 text-center">
        <h1 className="text-xl font-semibold">Not available for your account</h1>
        <p className="mt-3 text-sm leading-relaxed text-secondary">{access.reason}</p>
      </main>
    )
  }
  return <WorkspaceView />
}
