import { createFileRoute } from '@tanstack/react-router'

/** GET /api/machine/status — is this machine's daemon live? (Bearer device token) */
export const Route = createFileRoute('/api/machine/status')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).status(token)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
