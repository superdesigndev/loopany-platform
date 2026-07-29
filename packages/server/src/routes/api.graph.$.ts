import { createFileRoute } from '@tanstack/react-router'

/**
 * The Graph v1 workspace demo API.
 *
 *   GET  /api/graph/summary    workspace counters (sidebar)
 *   GET  /api/graph/system     objects + derived gate nodes + edges
 *   GET  /api/graph/library    artifacts with sanitized rendered HTML
 *   GET  /api/graph/timeline   the event feed (?limit=N)
 *   GET  /api/graph/inbox      open human-verdict obligations
 *   POST /api/graph/verdict    {objectId, transition} → applyTransition (human)
 *   POST /api/graph/seed       replay a production snapshot into THIS server's db
 *
 * ── the gate ────────────────────────────────────────────────────────────────
 *
 * This surface serves REAL production content, including support tickets with
 * customer names and emails. So every handler passes through `guard()` first:
 * the surface must be ENABLED, and outside local dev the caller must be signed
 * in AND on the workspace allowlist. The allowlist FAILS CLOSED — unset serves
 * no one (`lib/graphWorkspace.ts` explains why that inverts the app-wide rule).
 *
 * The guard runs before any database import, so a refused request costs nothing
 * and touches nothing.
 *
 * The heavy modules are imported INSIDE the handlers, per this repo's route
 * convention, so none of this reaches the client bundle.
 */

type Guarded = { ok: true; userId: string | null } | { ok: false; response: Response }

/** Enablement + auth, in that order. 404 when the surface does not exist here;
 *  401 when it does but this caller may not open it. */
async function guard(): Promise<Guarded> {
  const {
    graphWorkspaceEnabled,
    graphWorkspaceRequiresLogin,
    graphWorkspaceAllowlistConfigured,
    mayViewGraphWorkspace,
    graphWorkspaceDenialReason,
  } = await import('../lib/graphWorkspace.js')

  if (!graphWorkspaceEnabled()) {
    return { ok: false, response: Response.json({ error: 'not found' }, { status: 404 }) }
  }
  if (!graphWorkspaceRequiresLogin()) return { ok: true, userId: null }

  // With no allowlist there is no one to admit, so refuse BEFORE resolving a
  // session — a misconfigured server never even loads auth or the database.
  if (!graphWorkspaceAllowlistConfigured()) {
    return {
      ok: false,
      response: Response.json({ error: 'unauthorized', detail: graphWorkspaceDenialReason() }, { status: 401 }),
    }
  }

  const { currentUser } = await import('../auth.js')
  const user = await currentUser()
  if (!user || !mayViewGraphWorkspace(user.email)) {
    return {
      ok: false,
      response: Response.json({ error: 'unauthorized', detail: graphWorkspaceDenialReason() }, { status: 401 }),
    }
  }
  return { ok: true, userId: user.id }
}

const notFound = () => Response.json({ error: 'not found' }, { status: 404 })

export const Route = createFileRoute('/api/graph/$')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const gate = await guard()
        if (!gate.ok) return gate.response

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
        const gate = await guard()
        if (!gate.ok) return gate.response
        const action = String((params as { _splat?: string })._splat ?? '')
        if (action === 'verdict') return verdict(request, gate.userId)
        if (action === 'seed') return seed(request)
        return notFound()
      },
    },
  },
})

/** The one ordinary write: close a human-verdict gate through `applyTransition`. */
async function verdict(request: Request, userId: string | null): Promise<Response> {
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
  const result = await read.recordVerdict({
    objectId,
    transition,
    now: new Date().toISOString(),
    ...(userId ? { userId } : {}),
  })
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
}

/**
 * Load a production snapshot into THIS server's database.
 *
 * This exists because the deployed testing app runs the EMBEDDED pglite tier on
 * a mounted volume: there is no database URL to connect to from outside, and
 * pglite is single-writer, so the running app is the only process that can write
 * it. Seeding therefore has to go through the app itself.
 *
 * The request carries only the snapshot (which the operator pulled read-only
 * from production). Artifact BODIES are not uploaded — this server fetches them
 * from the artifact store with its OWN credentials, read-only, so no keys move
 * over the wire.
 *
 * Scope: `seedFromProdSnapshot` resets and rewrites only the graph tables' rows
 * for the demo team id. Unrelated tables, and every other team, are untouched.
 */
async function seed(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 })
  }
  const snapshot = (body ?? {}) as { files?: unknown; loops?: unknown; source?: unknown }
  if (snapshot.source !== 'loopany-production' || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.loops)) {
    return Response.json({ error: 'body must be a production snapshot (see graph:pull)' }, { status: 400 })
  }

  const { fetchArtifactBodies } = await import('../graph/workspace/fetch-bodies.js')
  const { seedFromProdSnapshot } = await import('../graph/workspace/seed-real.js')
  const typed = body as import('../graph/workspace/pull-prod.js').ProdSnapshot

  // Read-only GETs against the artifact store, cached on this machine's volume
  // so a re-seed is cheap and offline.
  const bodies = await fetchArtifactBodies({ files: typed.files })
  const result = await seedFromProdSnapshot({ snapshot: typed })

  return Response.json({
    ok: true,
    bodies: { requested: bodies.requested, fetched: bodies.fetched, cached: bodies.cached, missing: bodies.missing },
    objects: result.objects,
    edges: result.edges,
    events: result.events,
    openObligations: result.openObligations,
    pendingActions: result.pendingActions,
    refusals: result.refusals.length,
    dropped: result.dropped,
  })
}
