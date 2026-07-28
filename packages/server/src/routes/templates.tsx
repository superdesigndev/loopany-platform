import { createFileRoute } from '@tanstack/react-router'

import { listBundles } from '../server/loopApi'
import { TemplatesPage } from '../components/TemplatesPage'
import type { BundleView } from '../types'

/**
 * The PUBLIC template catalog (`/templates`). Deliberately does NO auth check of any kind
 * in its loader, so it renders logged OUT even when the login gate is on — there is no
 * global auth middleware (each route decides for itself; the dashboard/timeline routes
 * gate in their own loaders, this one does not). Shareable, marketing-grade URL.
 *
 * `listBundles` is public registry data (no membership scoping), and each resolved
 * member carries its editorial `rating` (merged in `templates.ts`).
 */
export const Route = createFileRoute('/templates')({
  ssr: false,
  head: () => ({
    meta: [
      { title: 'Loopany templates — agent loops that run while you sleep' },
      {
        name: 'description',
        content:
          'Browse every Loopany template for free: ready-to-run scheduled agent loops for code health, shipping, growth, ops, and more — rated for ease, cycle, and effect.',
      },
    ],
  }),
  loader: async (): Promise<{ bundles: BundleView[] }> => ({ bundles: await listBundles() }),
  component: TemplatesRoute,
})

function TemplatesRoute() {
  const { bundles } = Route.useLoaderData()
  return <TemplatesPage bundles={bundles} />
}
