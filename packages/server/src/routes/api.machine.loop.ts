import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody, machineCredential } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'

/** Retired owner-authoring transport. Human writes use /api/kernel/cli. */
export const Route = createFileRoute('/api/machine/loop')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        return Response.json({ error: 'machine credentials cannot author loops; use lk login' }, { status: token ? 403 : 401 })
      },
      GET: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        return Response.json({ error: 'machine credentials cannot read owner loop APIs; use lk login' }, { status: token ? 403 : 401 })
      },
      PATCH: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        return Response.json({ error: 'machine credentials cannot edit loops; use lk login' }, { status: token ? 403 : 401 })
      },
    },
  },
})
