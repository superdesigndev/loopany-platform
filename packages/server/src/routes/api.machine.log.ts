import { createFileRoute } from '@tanstack/react-router'
import { machineRouteLimit } from '../gateway/rateLimit'
import { machineCredential } from '../gateway/http'

/** Retired owner-read transport. Machine credentials cannot read transcripts. */
export const Route = createFileRoute('/api/machine/log')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        return Response.json({ error: 'machine credentials cannot read owner logs; use lk login' }, { status: 403 })
      },
    },
  },
})
