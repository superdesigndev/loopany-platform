import { createFileRoute, notFound } from '@tanstack/react-router'

import { WorkspaceView } from '../components/workspace/WorkspaceView'
import workspaceCss from '../styles/workspace.css?url'

/**
 * `/dev/workspace` — the Graph Engineering v1 workspace demo.
 *
 * DEV ONLY, and gated twice: `import.meta.env.PROD` short-circuits the loader in
 * a production bundle, and the `/api/graph/*` routes it reads refuse to answer
 * outside dev as well. Neither the page nor its data exists in a shipped build.
 *
 * The demo's stylesheet is loaded HERE via `?url` (a separate link, not an
 * import into the Tailwind sheet) and is scoped under `.loopany-workspace`, so
 * the demo skin cannot reach any other route.
 */
export const Route = createFileRoute('/dev/workspace')({
  head: () => ({
    meta: [{ title: 'Loopany — Graph v1 workspace' }],
    links: [{ rel: 'stylesheet', href: workspaceCss }],
  }),
  loader: () => {
    if (import.meta.env.PROD) throw notFound()
    return null
  },
  component: WorkspacePage,
})

function WorkspacePage() {
  return <WorkspaceView />
}
