import { createFileRoute } from '@tanstack/react-router'
import { machineRouteLimit } from '../gateway/rateLimit'
import { machineCredential } from '../gateway/http'

/** GET /api/machine/status — is this machine's daemon live? (Bearer device token) */
export const Route = createFileRoute('/api/machine/status')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).status(token)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
