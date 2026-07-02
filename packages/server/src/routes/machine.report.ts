import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

/** POST /machine/report — finalize a run (Bearer run token). */
export const Route = createFileRoute('/machine/report')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing token' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = parsed.kind === 'ok' ? parsed.body : {}
        const { getGateway } = await import('../server/boot.js')
        const gw = getGateway()
        const r = gw.report(token, body as Parameters<typeof gw.report>[1])
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
