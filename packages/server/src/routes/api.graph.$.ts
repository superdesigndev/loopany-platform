import { createFileRoute } from '@tanstack/react-router'

/**
 * The Graph Engineering v1 workspace demo API — DEV ONLY.
 *
 * One splat route rather than five files: these five projections are one
 * surface, they share a gate and a team scope, and keeping them together makes
 * the whole read/write contract legible in a single screen.
 *
 *   GET  /api/graph/summary    workspace counters (sidebar)
 *   GET  /api/graph/system     objects + derived gate nodes + edges
 *   GET  /api/graph/library    artifacts with sanitized rendered HTML
 *   GET  /api/graph/timeline   the event feed (?limit=N)
 *   GET  /api/graph/inbox      open human-verdict obligations
 *   POST /api/graph/verdict    {objectId, transition} → applyTransition (human)
 *
 * DEV GATE: the demo seeds a fixed team id and exposes an unauthenticated write
 * path, so the whole route refuses to serve in a production build. That gate is
 * here — in the handler — rather than in a build config, so it holds however the
 * bundle is assembled.
 *
 * The heavy modules (`db`, the graph store, the artifact renderer) are imported
 * INSIDE the handlers, per this repo's route convention, so nothing here reaches
 * the client bundle.
 */

const devOnly = () => process.env.NODE_ENV !== 'production'

const notFound = () => Response.json({ error: 'not found' }, { status: 404 })

export const Route = createFileRoute('/api/graph/$')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!devOnly()) return notFound()
        const view = String((params as { _splat?: string })._splat ?? '')
        const read = await import('../graph/workspace/read.js')
        const url = new URL(request.url)

        switch (view) {
          case 'summary':
            return Response.json(await read.summaryView())
          case 'system':
            return Response.json(await read.systemView())
          case 'library':
            return Response.json(await read.libraryView())
          case 'timeline': {
            const raw = Number(url.searchParams.get('limit'))
            const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 120
            return Response.json(await read.timelineView(undefined, limit))
          }
          case 'inbox':
            return Response.json(await read.inboxView())
          default:
            return notFound()
        }
      },

      POST: async ({ params, request }) => {
        if (!devOnly()) return notFound()
        if (String((params as { _splat?: string })._splat ?? '') !== 'verdict') return notFound()

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'body must be JSON' }, { status: 400 })
        }
        const { objectId, transition } = (body ?? {}) as { objectId?: unknown; transition?: unknown }
        if (typeof objectId !== 'string' || typeof transition !== 'string') {
          return Response.json({ error: 'objectId and transition are required strings' }, { status: 400 })
        }

        const read = await import('../graph/workspace/read.js')
        // The clock is READ HERE and passed in: `applyTransition` never reads one
        // itself (design §12 item 8), which is what makes history seedable.
        const result = await read.recordVerdict({ objectId, transition, now: new Date().toISOString() })
        if (!result.ok) {
          // A refusal is a typed decision, not a crash — hand the caller the code.
          return Response.json({ ok: false, code: result.code, message: result.message }, { status: 409 })
        }
        return Response.json({
          ok: true,
          replay: result.replay,
          status: result.object.status,
          eventId: result.event.id,
          closed: result.closed.map((o) => o.key),
          actions: result.actions.map((a) => ({ id: a.id, kind: a.kind, consequenceClass: a.consequenceClass })),
        })
      },
    },
  },
})
