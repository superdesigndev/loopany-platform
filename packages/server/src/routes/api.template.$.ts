import { createFileRoute } from '@tanstack/react-router'

// The template-market setup docs, inlined at build time (Vite ?raw glob) so they
// ship in the nitro bundle — same source of truth as the registry
// (packages/server/src/skill/templates/<name>/template.md). Served like
// /api/bootstrap: a per-template doc the coding agent fetches and follows to set the
// loop up (verify preconditions, author the config, `loopany new`, pre-bake the ui).
//
// SERVER-ONLY on purpose: the doc bytes are imported HERE (a server route, code-split
// out of the client bundle), never in server/templates.ts (which the client-reachable
// dashboard imports for the card metadata) — mirroring how bootstrap.md lives only in
// api.bootstrap.ts. Non-extension path (/api/template/<name>) so Vite's dev static
// layer doesn't swallow it, and we control the charset (static .md serving drops
// `charset=utf-8` and garbles UTF-8).
//
// Zero new code to add a template: the glob picks up any new
// skill/templates/*/template.md folder. Path-safe: only an exact folder name from the
// build-time DOCS map resolves; anything else (nested paths, traversal, unknown names)
// is a clean JSON 404 — like api.skill.references.$.ts.
const modules = import.meta.glob<string>('../skill/templates/*/template.md', {
  query: '?raw',
  eager: true,
  import: 'default',
})

// Map the globbed file paths to `<name> -> markdown`, keying on the folder name.
const DOCS: Record<string, string> = {}
for (const [path, body] of Object.entries(modules)) {
  const name = path.match(/\/templates\/([^/]+)\/template\.md$/)?.[1]
  if (name) DOCS[name] = body
}

const PREFIX = '/api/template/'

/** GET /api/template/:name — serve one template's setup doc as markdown (see TemplateModal). */
export const Route = createFileRoute('/api/template/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const pathname = new URL(request.url).pathname
        if (!pathname.startsWith(PREFIX)) return Response.json({ error: 'not found' }, { status: 404 })
        const name = pathname.slice(PREFIX.length)
        const body = Object.prototype.hasOwnProperty.call(DOCS, name) ? DOCS[name] : undefined
        if (body === undefined) return Response.json({ error: 'not found' }, { status: 404 })
        return new Response(body, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
        })
      },
    },
  },
})
