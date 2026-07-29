import { createFileRoute } from '@tanstack/react-router'

import { listPublicBundles } from '../server/loopApi'
import { TemplatesPage } from '../components/TemplatesPage'
import type { BundleView } from '../types'

/**
 * The PUBLIC template catalog (`/templates`). Deliberately does NO auth check of any kind
 * in its loader, so it renders logged OUT even when the login gate is on — there is no
 * global auth middleware (each route decides for itself; the dashboard/timeline routes
 * gate in their own loaders, this one does not). Shareable, marketing-grade URL.
 *
 * `listPublicBundles` is public registry data (no membership scoping), and each resolved
 * member carries its editorial `rating` (merged in `templates.ts`) but NOT its inlined
 * thumb.svg — this market is text-first and draws no illustration, so the SVGs would be
 * dead weight in the SSR payload.
 *
 * SSR is ON here (the app-wide `ssr: false` exists because every other route's loader
 * needs the browser session cookie — this one is static and auth-free), so crawlers and
 * link unfurlers get the real card grid + prompt previews in the server HTML alongside
 * the SEO meta. The interactive bits (category filter, copy buttons) hydrate as usual.
 */
export const Route = createFileRoute('/templates')({
  head: () => ({
    meta: [
      { title: 'Loopany templates — agent loops that actually work' },
      {
        name: 'description',
        content:
          'Browse every Loopany template for free: ready-to-run scheduled agent loops for growth, business ops, codebase upkeep, CI & security, and more — each showing when it runs, what it does, and what you get.',
      },
    ],
  }),
  loader: async (): Promise<{ bundles: BundleView[] }> => ({ bundles: await listPublicBundles() }),
  component: TemplatesRoute,
})

function TemplatesRoute() {
  const { bundles } = Route.useLoaderData()
  return <TemplatesPage bundles={bundles} />
}
