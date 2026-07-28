import { Link } from '@tanstack/react-router'
import type { BundleView } from '../types'
import { TemplateCard, flattenBundles, type MarketItem } from './TemplateCard'

/**
 * TemplatesPreview - the catalog teaser band on the dashboard, directly above the
 * playbook.
 *
 * It renders the SAME text-first card as the public market (`TemplateCard`, compact
 * variant) so the two surfaces cannot drift, over a CURATED subset: the lead template of
 * each bundle, one per category, in the curated bundle order. The grid is clipped and
 * masked so the second row fades out - the "there is more" cue - and the single
 * `Browse all N templates` affordance sits right after the fade.
 *
 * Pure content off the loader's static-per-deploy bundles (the dashboard poll never
 * re-ships them), so this band costs the page nothing at runtime.
 */
export function TemplatesPreview({ bundles }: { bundles: BundleView[] }) {
  const all = flattenBundles(bundles)
  const shown = pickPreview(bundles, PREVIEW_COUNT)
  if (!shown.length) return null

  return (
    <section className="mt-24 border-t border-hairline pt-16">
      <div className="text-center">
        <div className="font-pixel text-label uppercase tracking-[0.18em] text-secondary">Template catalog</div>
        <h2 className="mx-auto mt-3 max-w-[620px] font-pixel text-[clamp(21px,3.2vw,28px)] leading-[1.15] text-display">
          Start from a loop that already works
        </h2>
        <p className="mx-auto mt-4 max-w-[520px] text-body leading-relaxed text-secondary">
          Every template is a real prompt you run on your own machine with your own coding agent. Open one to read
          exactly what it does before you create it.
        </p>
      </div>

      {/* The teaser: TWO full rows of compact cards, with the third starting the fade.
          Cards keep a fixed height, so the clip lands in the same place at every
          viewport width (the row COUNT changes with the columns, the cut does not). */}
      <div className="templates-peek mt-8 overflow-hidden">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((it) => (
            <TemplateCard key={it.template.name} item={it} compact />
          ))}
        </div>
      </div>

      <div className="-mt-2 flex justify-center">
        <Link
          to="/templates"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-wire bg-surface px-5 py-2 text-body font-medium text-display transition-colors hover:bg-raised"
        >
          Browse all {all.length} templates
          <span aria-hidden>→</span>
        </Link>
      </div>
    </section>
  )
}

/** Three rows at the 3-column desktop width: two full, the third under the fade. */
const PREVIEW_COUNT = 9

/**
 * The curated subset, picked ROUND-ROBIN across bundles: every bundle's lead first (in
 * the registry's curated category order, Code Health -> ... -> Others), then every
 * bundle's second, and so on. So the band reads as a tour of the catalog at any count -
 * a flat top-up would fill the extra rows from whichever bundle happens to be first.
 */
function pickPreview(bundles: BundleView[], count: number): MarketItem[] {
  const flat = flattenBundles(bundles)
  const byBundle = bundles.map((b) => flat.filter((i) => i.categoryName === b.name))
  const deepest = byBundle.reduce((n, m) => Math.max(n, m.length), 0)
  const picked: MarketItem[] = []
  for (let rank = 0; rank < deepest && picked.length < count; rank++) {
    for (const members of byBundle) {
      if (picked.length >= count) break
      const item = members[rank]
      if (item) picked.push(item)
    }
  }
  return picked
}
