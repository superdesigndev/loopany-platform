import type { BundleView } from '../types'
import { TemplateCard, bundleItems } from './TemplateCard'
import { AgentLoopsHeadline } from './TemplatesPage'

/**
 * TemplatesPreview - the LOOP MARKETPLACE band, directly above the playbook on both
 * the dashboard and the pre-login landing.
 *
 * The FULL catalog, not a clipped teaser: every bundle renders as its own section
 * (curated order, label + tagline — the same shape as the public market's sections),
 * and every card goes STRAIGHT to compose (`composeDirect`: `/?template=<name>` →
 * `DashboardView.openTemplate`; for a signed-out visitor the param survives the login
 * redirect via `callbackURL`). No "Browse all" hop and no detail-page detour — the
 * shareable, prompt-readable market stays at `/templates` for the public.
 *
 * Pure content off the loader's static-per-deploy bundles (the dashboard poll never
 * re-ships them), so this band costs the page nothing at runtime.
 */
export function TemplatesPreview({ bundles }: { bundles: BundleView[] }) {
  const total = bundles.reduce((n, b) => n + b.members.length, 0)
  if (!total) return null

  return (
    <section className="mt-24 border-t border-hairline pt-16">
      {/* The SAME hero as /templates (shared component) — one brand voice everywhere. */}
      <div className="text-center">
        <AgentLoopsHeadline as="h2" compact />
        <p className="mx-auto mt-5 max-w-[520px] text-body leading-relaxed text-secondary">
          Ready-to-run loops that work while you sleep. Each one is a real prompt — pick one and set it up.
        </p>
      </div>

      {bundles.map((b) => (
        <div key={b.name} className="mt-10">
          <div className="flex items-baseline gap-2.5">
            <h3 className="band-section-head text-[19px] font-semibold tracking-[-0.015em] text-display">{b.label}</h3>
            <span className="text-meta text-disabled">{b.members.length}</span>
          </div>
          <p className="mt-1 text-caption text-secondary">{b.tagline}</p>
          <div className="mt-4 grid min-w-0 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {bundleItems(b).map((it) => (
              <TemplateCard key={it.template.name} item={it} composeDirect showCategory={false} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
