import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'

// Dev-only local env: this config runs in the dev server's node process, so vars
// loaded here reach the server functions via process.env (Vite never injects
// non-VITE_ vars into process.env on its own). Use it to point LOOPANY_CLI at the
// in-repo daemon so the New-loop paste tells Claude Code to run your local code
// instead of the published `npx @crewlet/loopany@latest`. Prod ignores it (the
// file isn't shipped). `.env.local` overrides `.env`; both are optional.
for (const f of ['.env', '.env.local']) {
  try {
    process.loadEnvFile(f)
  } catch {
    /* file absent — fine */
  }
}

/**
 * DEV ONLY — serve the skill reference `.md` routes from source.
 *
 * In dev, Vite's static/asset layer claims any request path ending in a known file
 * extension before the route handlers run, so `/api/skill/references/create.md`
 * 404s as HTML while the same route answers JSON for an extension-less path. Prod
 * (nitro) has no such layer and serves these fine — which means a bootstrapping
 * agent can read its references against loopany.ai but NOT against a dev server,
 * so template setup flows were untestable locally (hit 2026-07-20).
 *
 * This middleware runs before Vite's static layer and answers the same bytes the
 * route serves: the top-level references plus each template's on-demand
 * `templates/<name>/reference.md`. Read from disk on each request (dev = live
 * edits, no restart).
 *
 * The two names are matched by SHAPE, not by a copied list of filenames — the
 * route builds its key set from the same two shapes (explicit imports + a glob),
 * and a hardcoded list here would silently drift the moment a reference is added.
 * Both patterns exclude `/` and `.`, so a matched name can never traverse; a name
 * that matches but has no file on disk falls through to the route's own 404.
 */
function devSkillReferences(): Plugin {
  const PREFIX = '/api/skill/references/'
  const TOP_RE = /^[a-z0-9-]+\.md$/
  const TEMPLATE_RE = /^templates\/([a-z0-9-]+)\/reference\.md$/
  const skillDir = path.join(import.meta.dirname, 'src/skill')

  return {
    name: 'loopany-dev-skill-references',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0] ?? ''
        if (!pathname.startsWith(PREFIX)) return next()
        const name = decodeURIComponent(pathname.slice(PREFIX.length))

        let file: string | null = null
        if (TOP_RE.test(name)) file = path.join(skillDir, 'references', name)
        else {
          const slug = TEMPLATE_RE.exec(name)?.[1]
          if (slug) file = path.join(skillDir, 'templates', slug, 'reference.md')
        }
        // Unknown name → fall through to the real route, which returns its JSON 404.
        if (!file || !fs.existsSync(file)) return next()

        res.setHeader('content-type', 'text/markdown; charset=utf-8')
        res.setHeader('cache-control', 'no-cache')
        res.end(fs.readFileSync(file, 'utf8'))
      })
    },
  }
}

export default defineConfig({
  // Bind IPv4 127.0.0.1 (not the default IPv6 `localhost`) so the daemon + curl
  // reach the dev server at 127.0.0.1 consistently.
  server: { host: '127.0.0.1', port: Number(process.env.LOOPANY_PORT) || 3000, strictPort: !!process.env.LOOPANY_PORT },
  plugins: [
    devSkillReferences(),
    tailwindcss(),
    tanstackStart(),
    // Nitro builds the production server (default node-server preset → a
    // listening `.output/server/index.mjs`, started by `pnpm start`).
    nitro(),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
})
