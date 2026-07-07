import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

/** POST /agent-api/loop — the `loopany` shim's verbs (Bearer run token). */
export const Route = createFileRoute('/agent-api/loop')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ text: 'loopany: missing token', exitCode: 1 }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large')
          return Response.json({ text: 'loopany: body too large', exitCode: 1 }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { argv?: string[] }
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).agentApi(token, Array.isArray(body.argv) ? body.argv : [])
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
