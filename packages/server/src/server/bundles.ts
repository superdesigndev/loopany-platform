import type { BundleInfo, BundleView, TemplateDetailView } from '../types'
import { TEMPLATES } from './templates'

/**
 * The bundle registry — curated groupings of templates surfaced as the dashboard's
 * auto-playing bundle carousel (a plain slide carousel, one bundle in focus at a
 * time — deliberately not a rotating disc). A bundle is metadata only (mirror of the template
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

/**
 * The PUBLIC market view of the same registry: every bundle, every member, every
 * `description` — MINUS each member's inlined `thumb.svg`. The `/templates` market and
 * its detail page are text-first (they draw no illustration) and they SSR, so shipping
 * ~54KB of unused SVG in every public document is pure waste. The dashboard carousel
 * keeps `listBundles`, since it really does render the thumbs.
 */
export function publicBundles(): BundleView[] {
  return BUNDLES.map((b) => ({
    ...b,
    members: b.members.map(({ thumb: _thumb, ...m }) => m),
  }))
}

/**
 * Resolve ONE public template by slug, with the category context the detail view needs
 * (and without the unused thumb). The detail route preloads on card HOVER
 * (`defaultPreload: 'intent'`), so it must never pull the whole catalog to render a
 * single template. Unknown slug ⇒ null (the route turns that into a real 404).
 */
export function findPublicTemplate(slug: string): TemplateDetailView | null {
  for (const b of BUNDLES) {
    const member = b.members.find((m) => m.name === slug)
    if (!member) continue
    const { thumb: _thumb, ...template } = member
    return { template, categoryLabel: b.label, accent: b.accent }
  }
  return null
}
