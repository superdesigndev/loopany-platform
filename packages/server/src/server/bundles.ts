import type { BundleInfo, BundleView } from '../types'
import { TEMPLATES } from './templates'

/**
 * The bundle registry — curated groupings of templates surfaced as the dashboard's
 * rotating stage-select dial. A bundle is metadata only (mirror of the template
 * system): each is a folder under `../skill/bundles/<name>/` with a static `meta.json`
 * (`BundleInfo`), and `listBundles` resolves the member NAMES to their `TemplateInfo`s
 * from `TEMPLATES`. Adding a bundle is pure content — drop a folder; the Vite glob picks
 * it up here, no code change.
 *
 * PUBLIC but NOT bundled: like `skill/templates/`, the daemon's `sync-skill.mjs`
 * whitelist never ships `skill/bundles/` into the npm tarball (guarded by
 * `sync-skill.test.ts`).
 */
const metas = import.meta.glob<BundleInfo>('../skill/bundles/*/meta.json', {
  eager: true,
  import: 'default',
})

/**
 * Product-curated bundle order for the dashboard carousel (NOT alphabetical):
 * Code Health → Ship with Confidence → Growth → Business Ops → Personal → Others (the
 * individually-set-up catch-all, last). A bundle not in this list falls to the end,
 * name-sorted, so a new folder still shows.
 */
const BUNDLE_ORDER = ['code-health', 'ship-with-confidence', 'growth', 'business-ops', 'personal', 'others']
const orderOf = (name: string): number => {
  const i = BUNDLE_ORDER.indexOf(name)
  return i === -1 ? BUNDLE_ORDER.length : i
}

const byName = new Map(TEMPLATES.map((t) => [t.name, t]))

export const BUNDLES: BundleView[] = Object.values(metas)
  .map((meta) => ({
    name: meta.name,
    label: meta.label,
    tagline: meta.tagline,
    accent: meta.accent,
    individual: meta.individual ?? false,
    // Resolve member names to templates in the meta's order; skip unknown names so a
    // renamed/removed template never yields an undefined member (or crashes the carousel).
    members: meta.templates.map((n) => byName.get(n)).filter((t): t is NonNullable<typeof t> => Boolean(t)),
  }))
  .sort((a, b) => orderOf(a.name) - orderOf(b.name) || a.name.localeCompare(b.name))

/** The resolved bundles, in curated order — seeded into the dashboard by the route
 *  loader (static per deploy, like templates; never re-polled). */
export function listBundles(): BundleView[] {
  return BUNDLES
}
