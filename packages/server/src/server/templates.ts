import type { TemplateInfo } from '../types'

/**
 * The template-market registry — the pre-baked "loops with a recipe" a user can
 * mint from the dashboard instead of authoring a blank loop.
 *
 * File-based and zero-exec: each template is a folder under
 * `../skill/templates/<name>/` holding two static files —
 *   - `meta.json`     the TemplateInfo (name/label/desc/tags/slots) shown on the card
 *                     and returned by `listTemplates`; imported here (tiny, client-safe).
 *   - `template.md`   the agent-facing setup doc, served by the `/api/template/<name>`
 *                     route (server-only — kept OUT of this client-reachable module so
 *                     the doc bytes never ride into the browser bundle).
 *
 * Adding a template in a later batch is **pure content addition**: drop a new folder
 * with those two files. The Vite glob picks the metadata up here and the route glob
 * picks the doc up there — no code change to the registry or the endpoint.
 *
 * PUBLIC surface, like `bootstrap.md`: template docs ARE served over HTTP, but they
 * must NOT ship in the daemon npm tarball. `packages/daemon/scripts/sync-skill.mjs`
 * is a selective whitelist (SKILL.md + the 3 references only), so `skill/templates/`
 * never leaks into the bundle — guarded by `sync-skill.test.ts`.
 */
const metas = import.meta.glob<TemplateInfo>('../skill/templates/*/meta.json', {
  eager: true,
  import: 'default',
})

/** The registry, keyed by template name, sorted by name for a stable card order. */
export const TEMPLATES: TemplateInfo[] = Object.values(metas).sort((a, b) =>
  a.name.localeCompare(b.name),
)

/** The set of known template names — the path-safe allowlist for the serving route. */
export const TEMPLATE_NAMES: ReadonlySet<string> = new Set(TEMPLATES.map((t) => t.name))
