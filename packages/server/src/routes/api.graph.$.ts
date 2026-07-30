import { createFileRoute } from '@tanstack/react-router'

/**
 * The Graph v1 workspace demo API.
 *
 *   GET  /api/graph/summary    workspace counters (sidebar)
 *   GET  /api/graph/system     objects + derived gate nodes + edges
 *   GET  /api/graph/library    artifacts with sanitized rendered HTML
 *   GET  /api/graph/timeline   the event feed (?limit=N)
 *   GET  /api/graph/inbox      open human-verdict obligations
 *   GET  /api/graph/attention  dead-letters / parked chains / refused closes /
 *                              outward effects that never landed
 *   GET  /api/graph/notifications  what the `notify` action produced
 *   GET  /api/graph/work       work awaiting a go-ahead + what its runs did
 *   GET  /api/graph/effects    outward work orders and what became of them
 *                              (the AGENT's own wire is `/api/agent/*`, which is
 *                              bearer-token authed and never session authed)
 *   POST /api/graph/verdict    {objectId, transition} → applyTransition (human)
 *   POST /api/graph/attention  {kind, ref, verb} → acknowledge | retry (human)
 *   POST /api/graph/notifications/read   mark every notification read
 *   POST /api/graph/drain      run one outbox pass now (the executor also loops)
 *   POST /api/graph/seed       replay a production snapshot into THIS server's db
 *
 * There is deliberately NO "poll now" verb. Since captain decision 10 this server
 * holds no GitHub transport at all, so it could not honour one - sensing runs on the
 * machine, and the machine's own sweep is what makes mirrors fresh. What this
 * surface offers instead is the TRUTH about it: `summary.sensing` says when the
 * workspace was last observed and how much of it is stale, so an agent that is not
 * running is visible rather than indistinguishable from a quiet week on GitHub.
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

/**
 * Make sure the OUTBOX EXECUTOR loop is running.
 *
 * `boot.ts` starts it too, but boot only happens when something touches the
 * machine gateway or a server fn - and nothing on this surface does. Without this
 * the workspace would still WORK (a verdict drains its own consequences inline,
 * and `POST /api/graph/drain` runs a pass on demand), but the background loop -
 * the thing that settles an action nobody is watching - would never start on a
 * server that only ever serves the workspace. That is exactly the silent gap this
 * unit exists to close, so it is closed here rather than assumed.
 *
 * `startOutboxExecutor` is globalThis-guarded and idempotent, so calling it on
 * every request costs one map lookup after the first.
 */
async function ensureExecutor(): Promise<void> {
  const { startOutboxExecutor } = await import('../graph/outbox/executor.js')
  startOutboxExecutor()
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
        await ensureExecutor()
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
          case 'attention':
            return Response.json(await read.attentionView())
          case 'notifications':
            return Response.json(await read.notificationsView())
          case 'effects':
            return Response.json(await read.effectsView())
          case 'work':
            return Response.json(await read.workView())
          default:
            return notFound()
        }
      },

      POST: async ({ params, request }) => {
        const action = String((params as { _splat?: string })._splat ?? '')

        // The SEED is an operator action on a deployed app (see `seed()`), so it
        // also accepts an operator bearer token — which only someone who can set
        // this app's secrets could know. Scoped to seeding: no read path takes
        // it, so it can never pull customer content out.
        if (action === 'seed') {
          const { graphWorkspaceEnabled, graphSeedTokenMatches } = await import('../lib/graphWorkspace.js')
          if (!graphWorkspaceEnabled()) return notFound()
          if (graphSeedTokenMatches(request.headers.get('authorization'))) return seed(request)
        }

        const gate = await guard()
        if (!gate.ok) return gate.response
        await ensureExecutor()
        if (action === 'verdict') return verdict(request, gate.userId)
        if (action === 'attention') return resolveAttention(request, gate.userId)
        if (action === 'notifications/read') return markNotificationsRead()
        if (action === 'drain') return drain()
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
    // What the verdict CAUSED. The whole point of the executor: a decision the
    // response can only describe is a decision that did nothing.
    ...(result.effects ? { effects: result.effects } : {}),
  })
}

/**
 * Resolve one attention item. Both verbs are HUMAN-entrance events through the
 * counter (`outbox/attention.ts`), so clearing a stuck consequence is as
 * attributable as approving a gate - which is the point: an attention item that
 * could be dismissed without a record would be a flag, not a computed item.
 */
async function resolveAttention(request: Request, userId: string | null): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 })
  }
  const { kind, ref, verb } = (body ?? {}) as { kind?: unknown; ref?: unknown; verb?: unknown }
  const { ATTENTION_KINDS } = await import('../graph/types.js')
  if (typeof kind !== 'string' || !(ATTENTION_KINDS as readonly string[]).includes(kind)) {
    return Response.json({ error: `kind must be one of ${ATTENTION_KINDS.join('|')}` }, { status: 400 })
  }
  if (typeof ref !== 'string' || !ref) return Response.json({ error: 'ref is required' }, { status: 400 })
  if (verb !== 'acknowledge' && verb !== 'retry') {
    return Response.json({ error: 'verb must be acknowledge|retry' }, { status: 400 })
  }

  const { resolveAttention: resolve } = await import('../graph/outbox/attention.js')
  const { DEMO_TEAM_ID, DEMO_USER_ID } = await import('../graph/workspace/specs.js')
  const result = await resolve({
    teamId: DEMO_TEAM_ID,
    kind: kind as import('../graph/types.js').AttentionKind,
    ref,
    verb,
    now: new Date().toISOString(),
    userId: userId ?? DEMO_USER_ID,
  })
  if (!result.ok) return Response.json(result, { status: 409 })
  return Response.json(result)
}

async function markNotificationsRead(): Promise<Response> {
  const read = await import('../graph/workspace/read.js')
  return Response.json({ ok: true, marked: await read.markNotificationsRead() })
}

/**
 * Run ONE outbox pass now. The background executor already loops, so this is not
 * how effects normally happen - it exists so a demo (or a probe) can make the
 * queue drain on demand instead of waiting out a tick, and so the response can
 * report exactly what the pass did.
 */
async function drain(): Promise<Response> {
  const { drainOutbox } = await import('../graph/outbox/executor.js')
  const { DEMO_TEAM_ID } = await import('../graph/workspace/specs.js')
  const r = await drainOutbox({ now: new Date().toISOString(), teamId: DEMO_TEAM_ID, maxPasses: 20 })
  return Response.json({
    ok: true,
    claimed: r.claimed,
    done: r.done,
    failed: r.failed,
    deadLettered: r.deadLettered,
    outcomes: r.outcomes,
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
 * The snapshot (pulled read-only from production by the operator) arrives either
 * in the body or as a file already on the data volume. Artifact BODIES are never
 * uploaded — this server fetches them from the artifact store with its OWN
 * credentials, read-only, so no keys move over the wire.
 *
 * Scope: `seedFromProdSnapshot` resets and rewrites only the graph tables' rows
 * for the demo team id. Unrelated tables, and every other team, are untouched.
 */
async function seed(request: Request): Promise<Response> {
  // The snapshot may arrive in the body, or already sit on this machine's data
  // volume (uploaded with `flyctl ssh sftp put`, which is how the deployed app
  // gets it — a couple of megabytes of JSON is a file transfer, not a POST body).
  let snapshot: import('../graph/workspace/pull-prod.js').ProdSnapshot
  const raw = await request.text()
  if (raw.trim() && raw.trim() !== '{}') {
    try {
      snapshot = JSON.parse(raw)
    } catch {
      return Response.json({ error: 'body must be JSON' }, { status: 400 })
    }
  } else {
    const { readSnapshot, snapshotPath } = await import('../graph/workspace/pull-prod.js')
    try {
      snapshot = readSnapshot()
    } catch {
      return Response.json(
        { error: `no snapshot in the request body and none at ${snapshotPath()}` },
        { status: 400 },
      )
    }
  }

  if (snapshot?.source !== 'loopany-production' || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.loops)) {
    return Response.json({ error: 'not a production snapshot (see graph:pull)' }, { status: 400 })
  }

  const { fetchArtifactBodies } = await import('../graph/workspace/fetch-bodies.js')
  const { seedFromProdSnapshot } = await import('../graph/workspace/seed-real.js')

  // Read-only GETs against the artifact store, cached on this machine's volume
  // so a re-seed is cheap and offline.
  const bodies = await fetchArtifactBodies({ files: snapshot.files })
  const result = await seedFromProdSnapshot({ snapshot })

  return Response.json({
    ok: true,
    pulledAt: snapshot.pulledAt,
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
