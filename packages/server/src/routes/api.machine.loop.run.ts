import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

/** Bearer device token from the request (the machine's persisted ~/.loopany token). */
function deviceToken(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

/**
 * POST /api/machine/loop/run — one-shot dispatch (`loopany run <id>`): make the
 * task due NOW via the scheduler's nextRunAt path. Works on any task, cron or
 * not; 409 while a run is already open (never a silent skip).
 */
export const Route = createFileRoute('/api/machine/loop/run')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const token = deviceToken(request)
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { id?: unknown }
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).runLoopNow(token, body.id)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
