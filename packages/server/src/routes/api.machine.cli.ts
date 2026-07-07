import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

/**
 * POST /api/machine/cli — the ONE unified CLI dispatch (Bearer credential + `{argv}`).
 * The gateway's `cli()` branches by credential type: a `dk_`-prefixed device token
 * takes the owner verbs (new/loops/edit/log/show), any non-device run credential (an
 * `rk_`-prefixed run lease, or a pre-Batch-6 bare-UUID token) takes the per-run
 * `dispatch()` verbs plus the run-scoped `log`/`show` read branch. Same 2MB
 * `readJsonBody` cap as every other machine route. The legacy `/agent-api/loop`,
 * `/api/machine/loop`, and `/api/machine/log` endpoints stay as thin aliases onto the
 * same gateway logic (no behavior change for existing daemons).
 */
export const Route = createFileRoute('/api/machine/cli')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing credential' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { argv?: string[] }
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).cli(token, Array.isArray(body.argv) ? body.argv : [])
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
