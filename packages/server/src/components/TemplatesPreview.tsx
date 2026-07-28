import { Link } from '@tanstack/react-router'
import type { BundleView } from '../types'
import { TemplateCard, bundleItems, type MarketItem } from './TemplateCard'

/**
 * TemplatesPreview - the catalog teaser band, directly above the playbook on both the
 * dashboard and the pre-login landing.
 *
 * It renders the SAME text-first card as the public market (`TemplateCard`, compact
 * variant) so the two surfaces cannot drift, over a CURATED subset picked ROUND-ROBIN
 * across bundles: every bundle's lead first (curated category order), then every
 * bundle's second, and so on. The grid is clipped and masked so TWO full rows stay solid
 * and the THIRD starts the fade - the "there is more" cue - and the single
 * `Browse all N templates` affordance sits right after it, counting the WHOLE catalog.
 *
 * Pure content off the loader's static-per-deploy bundles (the dashboard poll never
 * re-ships them), so this band costs the page nothing at runtime.
 */
export function TemplatesPreview({ bundles }: { bundles: BundleView[] }) {
  const byBundle = bundles.map(bundleItems)
  const total = byBundle.reduce((n, members) => n + members.length, 0)
  const shown = pickPreview(byBundle, PREVIEW_COUNT)
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
          viewport width - and PEEK_VISIBILITY drops the cards a narrower column count
          would push entirely under the cut, so exactly three rows render at 1, 2 and 3
          columns. `overflow-clip` (not `hidden`) makes the box unscrollable, so nothing
          can ever shift the band up under the mask. */}
      <div className="templates-peek mt-8 overflow-clip">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((it, i) => (
            <TemplateCard key={it.template.name} item={it} compact className={PEEK_VISIBILITY[i]} />
          ))}
        </div>
      </div>

      <div className="-mt-2 flex justify-center">
        <Link
          to="/templates"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-wire bg-surface px-5 py-2 text-body font-medium text-display transition-colors hover:bg-raised"
        >
          Browse all {total} templates
          <span aria-hidden>→</span>
        </Link>
      </div>
    </section>
  )
}

/** Three rows at the 3-column desktop width: two full, the third under the fade. */
const PREVIEW_COUNT = 9

/**
 * Per-card visibility, so the fixed clip never hides a card that is still in the tab
 * order and the a11y tree. The grid is 1 column below `sm`, 2 up to `lg`, 3 above - so
 * the three rows the mask has room for are the first 3 / 6 / 9 cards. Everything past
 * that is `display: none` at that width (a plain CSS breakpoint, no measurement: this
 * band SSRs on the pre-login landing and must stay hook-free). The desktop layout is
 * untouched - at `lg` all nine cards are visible, exactly as before.
 */
const PEEK_VISIBILITY: (string | undefined)[] = [
  undefined,
  undefined,
  undefined,
  'hidden sm:flex',
  'hidden sm:flex',
  'hidden sm:flex',
  'hidden lg:flex',
  'hidden lg:flex',
  'hidden lg:flex',
]

/**
 * The curated subset, picked ROUND-ROBIN across bundles: every bundle's lead first (in
 * the registry's curated category order, Code Health -> ... -> Others), then every
 * bundle's second, and so on. So the band reads as a tour of the catalog at any count -
 * a flat top-up would fill the extra rows from whichever bundle happens to be first.
 */
function pickPreview(byBundle: MarketItem[][], count: number): MarketItem[] {
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
