/// <reference types="vite/client" />
import {
  HeadContent,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import appCss from '../styles/app.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Loopany' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: browser extensions (IME, translators, Dark
    // Reader, etc.) inject classes/attributes onto <html>/<body> before React
    // hydrates — e.g. a stray `idc0_*` class. Those attribute mismatches are
    // outside our control and harmless. This suppresses ONLY the html/body
    // elements' own attributes (it does not propagate to children), so real
    // mismatches deeper in the tree still warn.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body
        className="dot-grid-subtle bg-paper font-sans text-primary antialiased"
        suppressHydrationWarning
      >
        {children}
        <Scripts />
      </body>
    </html>
  )
}
