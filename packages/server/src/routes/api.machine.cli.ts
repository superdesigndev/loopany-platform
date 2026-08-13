import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody, machineCredential } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'

/**
 * POST /api/machine/cli — the ONE unified CLI dispatch (Bearer credential + `{argv}`).
 * Only run credentials are accepted here. Machine credentials never inherit
 * owner authority. Human commands use the session-authenticated kernel route. Same 2MB
 * `readJsonBody` cap as every other machine route. The legacy `/agent-api/loop`,
 * `/api/machine/loop`, and `/api/machine/log` endpoints stay as thin aliases onto the
 * same gateway logic (no behavior change for existing daemons).
 */
export const Route = createFileRoute('/api/machine/cli')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing credential' }, { status: 401 })
        if (token.includes('\nmk_') || token.startsWith('mk_')) return Response.json({ error: 'machine credentials cannot perform CLI operations' }, { status: 403 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { argv?: string[] }
        const { getCliGateway } = await import('../server/boot.js')
        const r = await (await getCliGateway()).cli(token, Array.isArray(body.argv) ? body.argv : [])
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
