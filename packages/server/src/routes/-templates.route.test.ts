import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `/templates` route must stay PUBLIC. There is no global auth middleware — each
 * route gates itself in its loader — so a public page simply avoids the gate helpers the
 * dashboard/timeline routes use. This source-level guard fails if a future edit slips an
 * auth check (or a signin redirect) into the route, silently breaking the shareable URL.
 */
const routeSrc = readFileSync(fileURLToPath(new URL('./templates.tsx', import.meta.url)), 'utf8')

describe('/templates route is PUBLIC (no auth gate)', () => {
  it('does no auth check of any kind in its loader', () => {
    expect(routeSrc).not.toContain('getAuthState')
    expect(routeSrc).not.toContain('authClient')
    expect(routeSrc).not.toContain('requestScope')
    expect(routeSrc).not.toContain('getSession')
    expect(routeSrc).not.toContain('SignIn')
    expect(routeSrc).not.toMatch(/redirect\(/)
  })

  it('seeds from the public bundle registry', () => {
    expect(routeSrc).toContain('listBundles')
    expect(routeSrc).toContain('createFileRoute')
  })
})
