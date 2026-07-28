import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `/templates` route must stay PUBLIC. There is no global auth middleware — each
 * route gates itself in its loader — so a public page simply avoids the gate helpers the
 * dashboard/timeline routes use. This source-level guard fails if a future edit slips an
 * auth check (or a signin redirect) into the route, silently breaking the shareable URL.
 */
const gridSrc = readFileSync(fileURLToPath(new URL('./templates.tsx', import.meta.url)), 'utf8')
const detailSrc = readFileSync(fileURLToPath(new URL('./templates_.$slug.tsx', import.meta.url)), 'utf8')

describe.each([
  // Each route seeds from its own PUBLIC (membership-free) registry server fn — the grid
  // takes the whole bundle list, the detail resolves ONE template by slug.
  ['/templates (grid)', gridSrc, 'listPublicBundles'],
  ['/templates/$slug (detail)', detailSrc, 'getPublicTemplate'],
])('%s route is PUBLIC (no auth gate)', (_name, src, publicFn) => {
  it('does no auth check of any kind in its loader', () => {
    expect(src).not.toContain('getAuthState')
    expect(src).not.toContain('authClient')
    expect(src).not.toContain('requestScope')
    expect(src).not.toContain('getSession')
    expect(src).not.toContain('SignIn')
    expect(src).not.toMatch(/redirect\(/)
  })

  it('seeds from the public registry', () => {
    expect(src).toContain(publicFn)
    expect(src).toContain("from '../server/loopApi'")
    expect(src).toContain('createFileRoute')
  })
})
