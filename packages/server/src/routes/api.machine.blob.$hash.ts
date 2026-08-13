import { createFileRoute } from '@tanstack/react-router'
import { machineCredential } from '../gateway/http'
import { safeDecode } from '../lib/url'

/**
 * PUT /api/machine/blob/:hash — upload one content-addressed blob's raw bytes
 * (Bearer DEVICE token). The server recomputes sha256(body) and rejects a
 * mismatch before storing in R2. The hash is read from the URL (the daemon PUTs
 * exactly the hashes the sync handshake returned in needHashes).
 *
 * This byte-ingress route is deliberately NOT rate limited: it requires a valid
 * registered device token (unknown ⇒ 401, not an unauthenticated surface) and is
 * already bounded by the sync hash-handshake (the server only accepts hashes it
 * asked THIS machine for) plus the per-loop 500MB / per-file 10MB byte caps. A
 * large first sync bursts many concurrent PUTs on one token, so any limiter would
 * only throttle legitimate uploads without adding real protection.
 */
export const Route = createFileRoute('/api/machine/blob/$hash')({
  server: {
    handlers: {
      PUT: async ({ request }: { request: Request }) => {
        const token = machineCredential(request)
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
