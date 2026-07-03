import type { TemplateInfo } from '../types'

/**
 * The template-market registry — canned loop INTENTS a user can mint from the
 * dashboard beside "New Loop". A template is metadata only, NOT a flow: clicking its
 * card appends `description` to the standard bootstrap snippet, and bootstrap.md +
 * create.md handle cadence, config, and dashboard authoring exactly as they do for a
 * blank loop.
 *
 * File-based and zero-exec: each template is a folder under `../skill/templates/<name>/`
 * with a single static `meta.json` (the `TemplateInfo`). Adding a template in a later
 * batch is pure content addition — drop a folder; the Vite glob picks it up here, no
 * code change. The `meta.json` is tiny and client-safe (it rides to the dashboard via
 * `listTemplates`).
 *
 * PUBLIC surface but NOT bundled: `packages/daemon/scripts/sync-skill.mjs` is a
 * selective whitelist (SKILL.md + the 3 references only), so `skill/templates/` never
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

/** The registry, sorted by name for a stable card order. */
export const TEMPLATES: TemplateInfo[] = Object.entries(metas)
  .map(([path, meta]) => ({ ...meta, thumb: thumbs[path.replace(/meta\.json$/, 'thumb.svg')] }))
  .sort((a, b) => a.name.localeCompare(b.name))
