import { createFileRoute } from '@tanstack/react-router'

/** GET /api/machine/log?loopId=<id>&limit=<n> — recent run transcripts for a loop
 *  bound to this machine (Bearer device token). The device-facing twin of the
 *  web-only getTranscript; strictly scoped to the token's own loop. */
export const Route = createFileRoute('/api/machine/log')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const url = new URL(request.url)
        const loopId = url.searchParams.get('loopId') ?? ''
        const limit = url.searchParams.get('limit') ?? undefined
        const { getGateway } = await import('../server/boot.js')
        const r = getGateway().loopLog(token, loopId, limit)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
