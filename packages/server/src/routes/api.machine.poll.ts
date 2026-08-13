import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody, machineCredential } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'

/** POST /api/machine/poll — daemon claims this machine's pending runs (Bearer device token). */
export const Route = createFileRoute('/api/machine/poll')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as {
          host?: string
          platform?: string
          arch?: string
          version?: string
          /** Team-local machine handle (the kernel assignee's machine segment). */
          alias?: string
          /** Executable agent profile names detected in this daemon process. */
          agentProfiles?: string[]
          progress?: Array<{ runId: string; step: number; label: string }>
          /** Long-poll opt-in: hold the request until work arrives (bounded server-side). */
          wait?: boolean
          /** Echo of the last applied watch digest — matching ⇒ `watch` omitted. */
          watchDigest?: string
        }
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).pollWait(token, body, body.progress, {
          wait: body.wait === true,
          watchDigest: typeof body.watchDigest === 'string' ? body.watchDigest : undefined,
        })
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
