import { createFileRoute, Link } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import { RunDetailView } from '../components/RunView'
import { SignIn } from '../components/SignIn'

/**
 * Run detail PAGE — `/loops/$loopId/runs/$runId`. A standalone page (the trailing
 * `_` on the `$loopId` segment opts it out of the loop page's component so the run
 * gets its own full surface, deep-linkable + browser-back friendly) rather than a
 * modal or an inline panel. It resolves the run from the loop's detail payload
 * (reusing getJobDetail — no new backend) and reuses the Phase 3 diff + transcript.
 *
 * Auth-gated like the dashboard (`/`) so a logged-out/expired DEEP LINK shows the
 * sign-in CTA instead of a raw `loop not found` error from the blocked fetch.
 */
export const Route = createFileRoute('/loops/$loopId_/runs/$runId')({
  ssr: false,
  loader: async () => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { auth }
    }
    return { auth }
  },
  component: RunDetailPage,
})

function RunDetailPage() {
  const { loopId, runId } = Route.useParams()
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  return (
    <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-10">
      <div className="mb-5">
        <Link
          to="/loops/$loopId"
          params={{ loopId }}
          className="inline-flex items-center gap-1.5 text-label font-medium text-secondary transition-colors hover:text-display"
        >
          <span aria-hidden>←</span> Back to loop
        </Link>
      </div>
      {auth?.enabled && !isPending && !session ? (
        <SignIn callbackURL={`/loops/${loopId}/runs/${runId}`} />
      ) : (
        <RunDetailView loopId={loopId} runId={runId} />
      )}
    </main>
  )
}
