import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'

import { getAuthState, listReviewQueue, markArtifactReviewed, type ReviewQueueRow } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import { LoopLogo } from '../components/LoopLogo'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'
import { rel } from '../lib/format'

/**
 * /review — the cross-loop WORKLIST (F7, notice + decide): every artifact a run
 * flagged `status: needs-review`, team-scoped, minus what's been marked
 * reviewed. The action is "MARK REVIEWED" — deliberately never "Approve":
 * nothing downstream consumes the verdict; the human does the thing themselves
 * and clears the item. Dismissal is server-side view state keyed to the content
 * hash, so a changed file re-surfaces for fresh eyes.
 */
export const Route = createFileRoute('/review')({
  ssr: false,
  loader: async () => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { rows: [] as ReviewQueueRow[], auth }
    }
    return { rows: await listReviewQueue(), auth }
  },
  component: Gate,
  errorComponent: LoadError,
})

function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't load the review queue." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function Gate() {
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  if (auth?.enabled && !isPending && !session) return <SignIn />
  return <ReviewPage />
}

function ReviewPage() {
  const initial = Route.useLoaderData()
  const [rows, setRows] = useState<ReviewQueueRow[]>(initial?.rows ?? [])
  const [busy, setBusy] = useState<string | null>(null)
  const navigate = useNavigate()

  // Fetch-then-set, never router.invalidate (repo rule).
  const refetch = useCallback(async () => {
    try {
      setRows(await listReviewQueue())
    } catch {
      /* keep what we have */
    }
  }, [])
  useEffect(() => {
    const t = setInterval(() => void refetch(), 15_000)
    return () => clearInterval(t)
  }, [refetch])

  const dismiss = async (r: ReviewQueueRow) => {
    setBusy(`${r.loopId}:${r.path}`)
    try {
      await markArtifactReviewed({ data: { loopId: r.loopId, path: r.path } })
      setRows((prev) => prev.filter((x) => !(x.loopId === r.loopId && x.path === r.path)))
    } catch {
      /* leave the row; the next poll re-syncs */
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-screen min-w-0 flex-col">
      <header className="shrink-0 border-b border-display/80 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <LoopLogo size={26} />
            <span className="font-display text-[20px] font-semibold tracking-tight text-display">Review</span>
            <span className="mt-0.5 font-mono text-[10px] tracking-[0.28em] text-secondary">NEEDS YOU</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/tasks"
              className="border border-wire bg-surface px-2.5 py-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display"
            >
              TASKS
            </Link>
            <Link
              to="/"
              className="border border-wire bg-surface px-2.5 py-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display"
            >
              DASHBOARD
            </Link>
          </div>
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {rows.length === 0 ? (
          <p className="font-mono text-[12px] text-secondary">Queue empty — nothing is waiting on you.</p>
        ) : (
          <ul className="flex max-w-[880px] flex-col gap-2">
            {rows.map((r) => (
              <li key={`${r.loopId}:${r.path}`} className="flex min-w-0 items-center gap-3 border border-wire bg-surface px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <button
                      type="button"
                      onClick={() => void navigate({ to: '/loops/$loopId', params: { loopId: r.loopId } })}
                      className="shrink-0 font-mono text-[11px] tracking-[0.06em] text-secondary underline-offset-2 hover:underline"
                    >
                      {r.task}
                    </button>
                    <span className="min-w-0 truncate text-[13px] font-medium text-display">{r.title ?? r.path}</span>
                    {r.due && <span className="shrink-0 font-mono text-[11px] text-[#c0392b]">⏰ {r.due}</span>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-disabled">
                    {r.path} · {rel(r.updatedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy === `${r.loopId}:${r.path}`}
                  onClick={() => void dismiss(r)}
                  className="shrink-0 border border-wire bg-paper px-2.5 py-1.5 font-mono text-[10.5px] tracking-[0.08em] text-secondary transition-colors hover:border-display hover:text-display disabled:opacity-50"
                >
                  MARK REVIEWED
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
