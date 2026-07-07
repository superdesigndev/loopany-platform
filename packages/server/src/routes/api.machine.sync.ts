import { createFileRoute } from '@tanstack/react-router'
import { readJsonBody } from '../gateway/http'

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
        const parsed = await readJsonBody(request, SYNC_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'sync body too large' }, { status: 413 })
        if (parsed.kind === 'invalid') return Response.json({ error: 'invalid JSON' }, { status: 400 })
        const { getArtifactSync } = await import('../server/boot.js')
        const r = await (await getArtifactSync()).sync(token, parsed.body as Record<string, unknown>)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
