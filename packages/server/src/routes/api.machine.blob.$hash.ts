import { createFileRoute } from '@tanstack/react-router'
import { safeDecode } from '../lib/url'

/**
 * PUT /api/machine/blob/:hash — upload one content-addressed blob's raw bytes
 * (Bearer DEVICE token). The server recomputes sha256(body) and rejects a
 * mismatch before storing in R2. The hash is read from the URL (the daemon PUTs
 * exactly the hashes the sync handshake returned in needHashes).
 */
export const Route = createFileRoute('/api/machine/blob/$hash')({
  server: {
    handlers: {
      PUT: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        // Malformed percent-encoding must be a clean 400, never a thrown 500.
        const hash = safeDecode(new URL(request.url).pathname.split('/').pop() ?? '')
        if (hash === null) return Response.json({ error: 'bad hash' }, { status: 400 })
        const { BLOB_CAP } = await import('../gateway/artifacts.js')
        const declared = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > BLOB_CAP)
          return Response.json({ error: 'blob exceeds size cap' }, { status: 413 })
        const buf = Buffer.from(await request.arrayBuffer())
        if (buf.length > BLOB_CAP) return Response.json({ error: 'blob exceeds size cap' }, { status: 413 })
        const { getArtifactSync } = await import('../server/boot.js')
        const r = await (await getArtifactSync()).putBlob(token, hash, buf)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
