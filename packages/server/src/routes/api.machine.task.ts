import { createFileRoute } from '@tanstack/react-router'

/** Bearer device token from the request (the machine's persisted ~/.loopany token). */
function deviceToken(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

/**
 * /api/machine/task — the machine's task-tree read channel (Bearer device token):
 *   GET ?op=list [&id=…&status=…&priority=…&due=1&recurring=1&tree=1&flat=1&depth=N]
 *   GET ?op=get&id=<slug|loopId> [&runs=1&limit=N&transcript=1]
 *   GET ?op=search&q=<keywords>
 *   GET ?op=review              — the needs-review worklist
 * Task FIELD writes stay on the existing loop channel (POST/PATCH
 * /api/machine/loop) — one validator path, per the two-surfaces-cannot-drift
 * rule. The ONE write here is review-clear: it mutates `review_marks` (queue
 * view-state), never a loop row, so the loop channel would be the contortion.
 */
export const Route = createFileRoute('/api/machine/task')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const token = deviceToken(request)
        const { machineRouteLimit } = await import('../gateway/rateLimit.js')
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const url = new URL(request.url)
        const q = (k: string): string | undefined => url.searchParams.get(k) ?? undefined
        const flag = (k: string): boolean => q(k) === '1' || q(k) === 'true'
        const { getGateway } = await import('../server/boot.js')
        const gw = await getGateway()
        const op = q('op') ?? 'list'
        let r
        if (op === 'get') {
          r = await gw.taskGet(token, q('id'), {
            runs: flag('runs'),
            limit: q('limit') ? Number(q('limit')) : undefined,
            transcript: flag('transcript'),
            log: flag('log'),
            since: q('since'),
            recent: q('recent') ? Number(q('recent')) : undefined,
          })
        } else if (op === 'search') {
          r = await gw.taskSearch(token, q('q'))
        } else if (op === 'list') {
          r = await gw.taskList(token, {
            id: q('id'),
            status: q('status'),
            priority: q('priority'),
            due: flag('due'),
            recurring: flag('recurring'),
            tree: flag('tree'),
            flat: flag('flat'),
            depth: q('depth') ? Number(q('depth')) : undefined,
            // Team-wide reads: --here = this machine only; --team = one
            // membership team (non-membership ⇒ flat 404 in the gateway).
            here: flag('here'),
            team: q('team'),
            assignee: q('assignee'),
          })
        } else if (op === 'review') {
          r = await gw.reviewQueue(token)
        } else {
          r = { status: 400, body: { error: "op must be one of: list, get, search, review" } }
        }
        return Response.json(r.body, { status: r.status })
      },
      // POST — the review queue's one write: dismiss an item ("mark reviewed").
      // Body { op: "review-clear", id, path }. Task WRITES stay on /api/machine/loop.
      POST: async ({ request }: { request: Request }) => {
        const token = deviceToken(request)
        const { machineRouteLimit } = await import('../gateway/rateLimit.js')
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const { readJsonBody, MACHINE_BODY_CAP } = await import('../gateway/http.js')
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { op?: string; id?: string; path?: string }
        const { getGateway } = await import('../server/boot.js')
        const gw = await getGateway()
        if (body.op !== 'review-clear') return Response.json({ error: 'op must be review-clear' }, { status: 400 })
        const r = await gw.reviewClear(token, body.id, body.path)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
