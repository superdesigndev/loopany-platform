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
 *   GET  /api/graph/schedule   every cadence, armed or merely configured, + its cursor
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
  // The CLOCK, for the same reason and with the same idempotent globalThis guard.
  // Without it a server that only ever serves the workspace would hold armed
  // schedules that never fire — the exact silent gap this unit exists to close, so
  // it is closed here rather than assumed to have come from boot.
  const { startGraphScheduler } = await import('../graph/schedule/scheduler.js')
  startGraphScheduler()
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
          case 'schedule':
            return Response.json(await read.scheduleView())
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
        // THE VERB SURFACE (captain decision 16). One endpoint per verb, the same
        // seven a run drives from the CLI, with a HUMAN actor. So a task a person
        // created in the browser and one an agent created from a run are the same
        // rows with the same shape, told apart by provenance rather than by which
        // code path made them - which is what makes the Timeline uniform.
        if (action.startsWith('verb/')) return humanVerb(action.slice('verb/'.length), request, gate.userId)
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

/**
 * ONE VERB, invoked by a person (captain decision 16).
 *
 *   POST /api/graph/verb/task.create   {type, title?, fields?, key?, for?}
 *   POST /api/graph/verb/task.move     {objectId, transition, note?}
 *   POST /api/graph/verb/artifact.push {body, title?, type?, for?, replaces?}
 *   POST /api/graph/verb/review.request{about?, question, preset?, fields?}
 *   POST /api/graph/verb/mirror.track  {ref, source?, externalId?, for?}
 *   POST /api/graph/verb/wait.open     {objectId, key, question, watcher}
 *   POST /api/graph/verb/wait.answer   {objectId, key, met, evidence}
 *
 * The SAME functions the CLI calls, with `entrance: "human"` and the signed-in
 * user as the actor. There is deliberately no argv here: a browser is not a text
 * sink, and giving the UI a second parser to keep in step would be the drift this
 * decision exists to remove. What is shared is the part that matters - the writes,
 * the guards, and the "what can I do next" answer.
 *
 * NOT ROLE-FENCED. The fence exists to keep ONE agent run narrow (decision 15a);
 * a person acting in their own workspace has no work order to be narrow about.
 */
async function humanVerb(name: string, request: Request, userId: string | null): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>
  } catch {
    return Response.json({ ok: false, code: 'VALIDATION_ERROR', message: 'body must be JSON' }, { status: 400 })
  }

  const verbs = await import('../graph/cli/verbs.js')
  const { DEMO_TEAM_ID, DEMO_USER_ID } = await import('../graph/workspace/specs.js')
  const ctx: import('../graph/cli/verbs.js').VerbContext = {
    teamId: (typeof body.teamId === 'string' && body.teamId.trim()) || DEMO_TEAM_ID,
    // A PERSON, always. The seam records the entrance verbatim, and a gate state's
    // outgoing transition is admitted on exactly this basis (design §12 item 5).
    actor: { entrance: 'human', actorId: userId ?? DEMO_USER_ID },
    ...(typeof body.subject === 'string' && body.subject.trim() ? { subjectId: body.subject.trim() } : {}),
    now: new Date().toISOString(),
  }

  const s = (k: string): string | undefined => {
    const v = body[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const fields = (body.fields ?? undefined) as Record<string, unknown> | undefined

  let result: import('../graph/cli/verbs.js').VerbResult
  switch (name) {
    case 'task.create':
      result = await verbs.taskCreate(ctx, {
        type: s('type') ?? '',
        ...(s('title') ? { title: s('title')! } : {}),
        ...(s('key') ? { key: s('key')! } : {}),
        ...(s('for') ? { forId: s('for')! } : {}),
        ...(fields ? { fields } : {}),
      })
      break
    case 'task.move':
      result = await verbs.taskMove(ctx, {
        objectId: s('objectId') ?? '',
        transition: s('transition') ?? '',
        ...(s('note') ? { note: s('note')! } : {}),
      })
      break
    case 'artifact.push':
      result = await verbs.artifactPush(ctx, {
        body: typeof body.body === 'string' ? body.body : '',
        ...(s('title') ? { title: s('title')! } : {}),
        ...(s('type') ? { type: s('type')! } : {}),
        ...(s('for') ? { forId: s('for')! } : {}),
        ...(s('replaces') ? { replacesId: s('replaces')! } : {}),
      })
      break
    case 'review.request':
      result = await verbs.reviewRequest(ctx, {
        question: s('question') ?? '',
        ...(s('about') ? { aboutId: s('about')! } : {}),
        ...(s('preset') ? { preset: s('preset')! } : {}),
        ...(s('title') ? { title: s('title')! } : {}),
        ...(fields ? { fields } : {}),
      })
      break
    case 'mirror.track':
      result = await verbs.mirrorTrack(ctx, {
        ref: s('ref') ?? '',
        ...(s('source') ? { source: s('source')! } : {}),
        ...(s('externalId') ? { externalId: s('externalId')! } : {}),
        ...(s('title') ? { title: s('title')! } : {}),
        ...(s('for') ? { forId: s('for')! } : {}),
      })
      break
    case 'wait.open':
      result = await verbs.waitOpen(ctx, {
        objectId: s('objectId') ?? '',
        key: s('key') ?? '',
        question: s('question') ?? '',
        watcherId: s('watcher') ?? '',
        ...(s('label') ? { label: s('label')! } : {}),
      })
      break
    case 'wait.answer':
      result = await verbs.waitAnswer(ctx, {
        objectId: s('objectId') ?? '',
        key: s('key') ?? '',
        met: body.met === true,
        evidence: s('evidence') ?? '',
      })
      break
    default:
      return notFound()
  }

  // A refused verb is a 409, like a refused verdict: the engine decided, and the
  // typed code plus the `allowed` list is exactly what the caller should show.
  return Response.json(result, { status: result.ok ? 200 : 409 })
}

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
  const { restrictConfiguredSnapshot } = await import('../graph/workspace/snapshot-scope.js')

  // SCOPE FIRST (`LOOPANY_GRAPH_SEED_LOOPS`), so bodies are never fetched for a
  // loop this deploy is not going to seed. The seeder applies the same pure
  // restriction again — it is idempotent, and being the chokepoint is what makes
  // the scope hold for every caller.
  let scoped: import('../graph/workspace/snapshot-scope.js').RestrictedSnapshot
  try {
    scoped = restrictConfiguredSnapshot(snapshot)
  } catch (err) {
    // A scope naming a loop the snapshot lacks is an operator error, and seeding
    // an empty workspace would look exactly like a broken deploy. Say so.
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
  snapshot = scoped.snapshot

  // Read-only GETs against the artifact store, cached on this machine's volume
  // so a re-seed is cheap and offline.
  const bodies = await fetchArtifactBodies({ files: snapshot.files })
  const result = await seedFromProdSnapshot({ snapshot })

  return Response.json({
    ok: true,
    pulledAt: snapshot.pulledAt,
    scope: { kept: scoped.kept, excluded: scoped.excluded.length },
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
