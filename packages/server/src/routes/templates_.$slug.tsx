import { createFileRoute } from '@tanstack/react-router'

import { listBundles } from '../server/loopApi'
import { TemplateDetail, type TemplateDetailData } from '../components/TemplateDetail'

/**
 * The PUBLIC template detail (`/templates/<slug>`) — a shareable, linkable page for one
 * template. Like `/templates` it does NO auth check (renders logged out under the gate).
 * Resolves the template + its category from the public bundle registry; an unknown slug
 * renders a friendly not-found (never an auth redirect or a crash).
 */
export const Route = createFileRoute('/templates_/$slug')({
  ssr: false,
  head: ({ params }) => ({
    meta: [{ title: `${params.slug} — Loopany template` }],
  }),
  loader: async ({ params }): Promise<{ data: TemplateDetailData | null }> => {
    const bundles = await listBundles()
    for (const b of bundles) {
      const template = b.members.find((m) => m.name === params.slug)
      if (template) return { data: { template, categoryLabel: b.label, accent: b.accent } }
    }
    return { data: null }
  },
  component: TemplateDetailRoute,
})

function TemplateDetailRoute() {
  const loaded = Route.useLoaderData() as { data: TemplateDetailData | null } | undefined
  return <TemplateDetail data={loaded?.data ?? null} />
}
