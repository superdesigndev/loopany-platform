import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the dashboard's poll resilience.
 *
 * The 3s/10s poll used to re-run the route loader via `router.invalidate()`;
 * the loader's Promise.all THROWS on any rejection, and with no errorComponent
 * a transient blip mid-poll swapped the dashboard for the router's default
 * error screen AND killed the polling interval (never self-heals). The poll
 * must be fetch-then-set with a catch (stale data survives a blip), and the
 * route must carry a retryable errorComponent for the first-load failure case.
 */
const src = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8')
const switcher = readFileSync(
  fileURLToPath(new URL('../components/TeamSwitcher.tsx', import.meta.url)),
  'utf8',
)

describe('dashboard poll resilience', () => {
  it('registers a retryable errorComponent for first-load failures', () => {
    expect(src).toMatch(/errorComponent:\s*LoadError/)
    expect(src).toMatch(/function LoadError\b/)
    // The retry affordance lives in the shared LoadErrorCard.
    expect(src).toContain('LoadErrorCard')
    expect(src).toContain('onRetry=')
  })

  it('polls fetch-then-set with a catch — never router.invalidate on a tick', () => {
    const refetch = /const refetch = useCallback\(async \(\) => \{[\s\S]*?\}, \[\]\)/.exec(src)?.[0]
    expect(refetch, 'the refetch callback should exist').toBeTruthy()
    expect(refetch).toContain('catch')
    expect(refetch).toContain('setData')
    // The interval tick calls refetch; the only invalidate left is the
    // errorComponent's explicit Retry (which re-runs the loader on purpose).
    const tick = /setInterval\(\s*\(\) => \{[\s\S]*?\},\s*anyRunning/.exec(src)?.[0]
    expect(tick, 'the poll interval should exist').toBeTruthy()
    expect(tick).toContain('void refetch()')
    expect(tick).not.toContain('invalidate')
  })

  it('team switch refreshes via the page refetch, not router.invalidate', () => {
    // The dashboard renders from its own fetch-then-set state (seeded once from
    // the loader), so router.invalidate would leave the visible data stale —
    // the switcher must be handed the page's refetch instead.
    expect(src).toContain('<TeamSwitcher data={teams} onSwitch={refresh} />')
    expect(switcher).not.toContain('useRouter')
    expect(switcher).not.toContain('invalidate()')
  })
})

describe('dashboard template fan layout', () => {
  it('fan cards wrap and stay fixed-width - no template count may widen the page', () => {
    // The hero template fan grows with the registry. Per the
    // no-page-level-horizontal-scroll rule the fan row must WRAP at narrow
    // widths (flex-wrap on the container) and each card is a fixed narrow
    // width (w-[..px] shrink-0), so no count of templates can overflow the
    // viewport - extra cards fold into a second row instead.
    const fan = /<div className="flex flex-wrap[^"]*">[\s\S]*?templates\.map/.exec(src)?.[0]
    expect(fan, 'the wrapping fan row should contain the template cards').toBeTruthy()
    const card = /templates\.map\([\s\S]*?className="([^"]*)"/.exec(src)?.[1]
    expect(card, 'the template card should have a className').toBeTruthy()
    expect(card).toMatch(/\bw-\[\d+px\]/)
    expect(card).toContain('shrink-0')
  })
})
