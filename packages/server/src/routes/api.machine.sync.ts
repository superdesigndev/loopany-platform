import { createFileRoute } from '@tanstack/react-router'

/**
 * POST /api/machine/sync — live artifact sync (Bearer DEVICE token, not the run
 * token). The daemon posts a loop's full file manifest + optional inline bytes;
 * the server stores blobs + reconciles artifact_files and replies with needHashes.
 * Larger body limit than the default JSON routes (a sync may inline small files).
 */
export const Route = createFileRoute('/api/machine/sync')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const { SYNC_BODY_CAP } = await import('../gateway/artifacts.js')
        const declared = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > SYNC_BODY_CAP)
          return Response.json({ error: 'sync body too large' }, { status: 413 })
        const text = await request.text().catch(() => '')
        if (text.length > SYNC_BODY_CAP) return Response.json({ error: 'sync body too large' }, { status: 413 })
        let body: unknown
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        const { getGateway } = await import('../server/boot.js')
        const r = await getGateway().sync(token, body as Record<string, unknown>)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
