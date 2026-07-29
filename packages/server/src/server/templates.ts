import type { TemplateInfo } from '../types'
import { TEMPLATE_RATINGS } from './templateRatings'

/**
 * The template-market registry — canned loop INTENTS a user can mint from the dashboard
 * (grouped into the bundle carousel's categories, `server/bundles.ts`) or from the public
 * market at `/templates`. A template is metadata only, NOT a flow: picking its card
 * appends `description` to the standard bootstrap snippet, and bootstrap.md + create.md
 * handle cadence, config, and dashboard authoring exactly as they do for a blank loop.
 *
 * File-based and zero-exec: each template is a folder under `../skill/templates/<name>/`
 * with a single static `meta.json` (the `TemplateInfo`). Adding a template is content
 * addition — drop a folder; the Vite glob picks it up here, no code change — but it must
 * also be named in one bundle meta (every user-facing surface reads the bundles) and get
 * a `templateRatings.ts` entry. The `meta.json` is tiny and client-safe.
 *
 * PUBLIC surface but NOT bundled: `packages/daemon/scripts/sync-skill.mjs` is a
 * selective whitelist (SKILL.md + the 4 references only), so `skill/templates/` never
 * leaks into the daemon npm tarball — guarded by `sync-skill.test.ts`.
 */
const metas = import.meta.glob<TemplateInfo>('../skill/templates/*/meta.json', {
  eager: true,
  import: 'default',
})

/**
 * Optional per-template preview: a `thumb.svg` beside the meta.json, inlined as
 * a string (`?raw`, same mechanism as the skill markdown). Drawn with the
 * theme's CSS variables so the preview follows light/dark for free. Still pure
 * content addition - drop the file and the glob pairs it by folder.
 */
const thumbs = import.meta.glob<string>('../skill/templates/*/thumb.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
})

/**
 * Optional per-template FIELD NOTES: a `story.md` beside the meta.json — the honest
 * write-up of how the loop ran for real (results, learnings, what to tweak), rendered
 * on the public detail page (`/templates/<slug>`) under "Field notes". REPO-AUTHORED
 * and trusted, like `thumb.svg`. Served ONLY through `findPublicTemplate` (the detail
 * loader), never on the list payloads — a long write-up must not bloat the market grid.
 */
const stories = import.meta.glob<string>('../skill/templates/*/story.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

/**
 * Story MEDIA lives in `public/template-assets/<name>/` (nitro serves `public/`
 * verbatim in dev AND prod), referenced from the story markdown by relative path
 * (`![…](assets/shot.png)`, `<video src="assets/demo.mp4">`) — `templateStory`
 * rewrites those to `/template-assets/<name>/…`. Deliberately NOT Vite `?url`
 * assets: an SSR-emitted `/assets/<hash>` URL is not publicly served by the nitro
 * build (the 2026-07-29 prod 404s). Keep videos SMALL (they live in git); for
 * anything heavy, embed a hosted player instead.
 */

/** The template's field-notes markdown (front matter stripped, asset refs rewritten to
 *  their served URLs), or null when the folder ships none. */
export function templateStory(name: string): string | null {
  const raw = stories[`../skill/templates/${name}/story.md`]
  if (!raw) return null
  return rewriteStoryAssets(stripFrontMatter(raw), name)
}

/**
 * Drop a leading `---` front-matter block. Authors keep publishing metadata (status,
 * internal notes) in the file; it must never render on the public page. Pure; returns
 * the input unchanged when no front matter opens the file.
 */
export function stripFrontMatter(md: string): string {
  if (!md.startsWith('---\n')) return md
  const end = md.indexOf('\n---\n', 4)
  if (end === -1) return md
  return md.slice(end + 5).replace(/^\s+/, '')
}

/** Rewrite `assets/<file>` references (markdown links/images AND raw-HTML src attrs)
 *  to the public URLs under `/template-assets/<name>/`. Pure; a ref to a file the
 *  author never dropped in `public/template-assets/<name>/` 404s VISIBLY rather than
 *  silently vanishing. */
export function rewriteStoryAssets(md: string, name: string): string {
  return md.replace(/(\]\(|src=")(?:\.\/)?assets\//g, `$1/template-assets/${name}/`)
}

/**
 * Product-curated card order (NOT alphabetical), grouped to mirror the dashboard
 * carousel's bundle order: Code Health → Ship with Confidence → Growth → Business Ops →
 * Personal → Others. A bundle resolves its OWN member order from its meta, so this order
 * only governs the flat `TEMPLATES` list; a template not listed falls to the end,
 * name-sorted, so a new folder still shows.
 */
const CARD_ORDER = [
  // Code Health
  'docs-sweep', 'error-sweep', 'react-doctor', 'housekeeper', 'dependency-triage',
  // Ship with Confidence
  'test-guardian', 'security-sweep', 'ci-doctor',
  // Growth
  'reddit-karma', 'seo-try-keywords', 'seo-scale-keywords', 'market-research', 'changelog-broadcaster',
  // Business Ops
  'support-triage', 'metrics-digest', 'funnel-watch',
  // Personal
  'morning-briefing', 'homebrew-updater', 'daily-lesson',
  // Others (individually-created, closed loops)
  'follow-up-tracker', 'outcome-watch', 'bug-vigil', 'release-shepherd',
]
const orderOf = (name: string): number => {
  const i = CARD_ORDER.indexOf(name)
  return i === -1 ? CARD_ORDER.length : i
}

export const TEMPLATES: TemplateInfo[] = Object.entries(metas)
  .map(([path, meta]) => ({
    ...meta,
    thumb: thumbs[path.replace(/meta\.json$/, 'thumb.svg')],
    // Merge the editorial rating (public template list, round 6) from the one ratings
    // table; a template with no entry simply renders without a rating chip row.
    rating: TEMPLATE_RATINGS[meta.name],
  }))
  .sort((a, b) => orderOf(a.name) - orderOf(b.name) || a.name.localeCompare(b.name))
