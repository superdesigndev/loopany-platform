import { createFileRoute, notFound } from '@tanstack/react-router'

import { listPublicBundles } from '../server/loopApi'
import { TemplateDetail, type TemplateDetailData } from '../components/TemplateDetail'

/**
 * The PUBLIC template detail (`/templates/<slug>`) — a shareable, linkable page for one
 * template. Like `/templates` it does NO auth check (renders logged out under the gate)
 * and it SSRs (its loader is the static, auth-free registry), so a shared link unfurls
 * with the real title, description, and prose instead of an empty shell. The payload is
 * the thumb-stripped public registry (`listPublicBundles`) — this view draws no thumb.
 *
 * An unknown slug throws `notFound()`: the SAME friendly not-found page renders (never an
 * auth redirect, never a crash) but under a REAL HTTP 404, so a crawler can't index
 * unbounded `/templates/<anything>` URLs as valid pages.
 */
export const Route = createFileRoute('/templates_/$slug')({
  loader: async ({ params }): Promise<{ data: TemplateDetailData }> => {
    const bundles = await listPublicBundles()
    for (const b of bundles) {
      const template = b.members.find((m) => m.name === params.slug)
      if (template) return { data: { template, categoryLabel: b.label, accent: b.accent } }
    }
    throw notFound()
  },
  // Title/description come from the RESOLVED template (a human label, not the raw slug);
  // the slug is only the fallback, since a share card must never read as an internal
  // identifier.
  head: ({ params, loaderData }) => {
    const t = (loaderData as { data: TemplateDetailData } | undefined)?.data?.template
    return {
      meta: [
        { title: t ? `${t.label} — Loopany template` : `${params.slug} — Loopany template` },
        {
          name: 'description',
          content: t
            ? `${t.desc} A free Loopany template: a scheduled agent loop you run on your own machine with your own coding agent.`
            : 'This Loopany template does not exist (or was renamed). Browse every free, ready-to-run agent loop template.',
        },
      ],
    }
  },
  notFoundComponent: () => <TemplateDetail data={null} />,
  component: TemplateDetailRoute,
})

function TemplateDetailRoute() {
  const loaded = Route.useLoaderData() as { data: TemplateDetailData } | undefined
  return <TemplateDetail data={loaded?.data ?? null} />
}
