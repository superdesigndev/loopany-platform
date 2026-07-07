import { createFileRoute } from '@tanstack/react-router'
import { safeDecode } from '../lib/url'

/**
 * GET /api/artifact/:loopId/:path — stream one of a loop's live-synced artifact
 * blobs (the download affordance for binary/oversize files; text is shown inline
 * via getArtifact). Authed via the WEB SESSION (not a machine token) and scoped
 * to the loop's team, mirroring the server fns' `ownedLoop` gate. Path-safe: the
 * relative path is normalized + traversal-rejected before it ever reaches a blob,
 * and blob keys are content hashes, never the user path. Reads stream from the
 * BlobStore (in-memory in dev/tests, R2 in prod); the route never writes.
 */
const PREFIX = '/api/artifact/'

export const Route = createFileRoute('/api/artifact/$loopId/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const pathname = new URL(request.url).pathname
        if (!pathname.startsWith(PREFIX)) return Response.json({ error: 'not found' }, { status: 404 })
        const after = pathname.slice(PREFIX.length)
        const slash = after.indexOf('/')
        if (slash < 0) return Response.json({ error: 'missing path' }, { status: 400 })
        // Malformed percent-encoding must be a clean 400, never a thrown 500.
        const loopId = safeDecode(after.slice(0, slash))
        if (loopId === null) return Response.json({ error: 'bad loop id' }, { status: 400 })
        // Decode each segment so a path like `data/raw.json` round-trips intact;
        // ANY malformed segment is a 400 (same policy as the loop id).
        const segments = after
          .slice(slash + 1)
          .split('/')
          .map((s) => safeDecode(s))
        if (segments.some((s) => s === null)) return Response.json({ error: 'bad path' }, { status: 400 })
        const relPath = segments.join('/')

        // Session auth + team scope (the same gate as the server fns' ownedLoop).
        const store = await import('../db/store.js')
        const loop = await store.getLoop(loopId)
        if (!loop) return Response.json({ error: 'not found' }, { status: 404 })
        const { requestScope, loopInScope } = await import('../auth.js')
        if (!loopInScope(loop.teamId, await requestScope()))
          return Response.json({ error: 'not found' }, { status: 404 })

        const { readLoopArtifactBytes } = await import('../server/artifactFiles.js')
        const r = await readLoopArtifactBytes(loopId, relPath)
        if (r.status !== 200 || !r.bytes)
          return Response.json({ error: 'not found' }, { status: r.status })

        const filename = (r.filename || 'file').replace(/["\\\r\n]/g, '_')
        return new Response(new Uint8Array(r.bytes), {
          status: 200,
          headers: {
            'content-type': r.binary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
            'content-length': String(r.bytes.length),
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'private, no-store',
          },
        })
      },
    },
  },
})
