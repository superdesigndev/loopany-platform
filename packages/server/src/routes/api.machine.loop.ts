import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

/** Bearer device token from the request (the machine's persisted ~/.adscaile token). */
function deviceToken(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

/**
 * /api/machine/loop — the machine's authenticated loop channel (Bearer device token):
 *   POST   Claude Code creates a loop (paste-forward New Loop)
 *   GET    list the loops bound to this machine (`adscaile loops`)
 *   PATCH  edit a loop's scheduling envelope (`adscaile edit`)
 */
export const Route = createFileRoute('/api/machine/loop')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const token = deviceToken(request)
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as Record<string, unknown>
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).createLoop(token, body)
        return Response.json(r.body, { status: r.status })
      },
      GET: async ({ request }: { request: Request }) => {
        const token = deviceToken(request)
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).listLoops(token)
        return Response.json(r.body, { status: r.status })
      },
      PATCH: async ({ request }: { request: Request }) => {
        const token = deviceToken(request)
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { id?: unknown; patch?: Record<string, unknown>; dryRun?: unknown }
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).editLoop(token, body.id, body.patch ?? {}, body.dryRun === true)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
