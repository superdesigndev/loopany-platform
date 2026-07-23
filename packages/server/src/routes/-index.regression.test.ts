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
// The route file keeps only the loader + errorComponent; the dashboard BODY (poll,
// switcher, bundle dial) moved to the shared DashboardView (rendered by both `/`
// in open mode and `/t/$teamId`), so the body guards read from there.
const src = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8')
const teamRoute = readFileSync(fileURLToPath(new URL('./t.$teamId.tsx', import.meta.url)), 'utf8')
const view = readFileSync(
  fileURLToPath(new URL('../components/DashboardView.tsx', import.meta.url)),
  'utf8',
)
const appCss = readFileSync(fileURLToPath(new URL('../styles/app.css', import.meta.url)), 'utf8')
const switcher = readFileSync(
  fileURLToPath(new URL('../components/TeamSwitcher.tsx', import.meta.url)),
  'utf8',
)

describe('dashboard poll resilience', () => {
  it('registers a retryable errorComponent for first-load failures on both routes', () => {
    for (const s of [src, teamRoute]) {
      expect(s).toMatch(/errorComponent:\s*LoadError/)
      expect(s).toMatch(/function LoadError\b/)
      // The retry affordance lives in the shared LoadErrorCard.
      expect(s).toContain('LoadErrorCard')
      expect(s).toContain('onRetry=')
    }
  })

  it('polls fetch-then-set with a catch — never router.invalidate on a tick', () => {
    const refetch = /const refetch = useCallback\(async \(\) => \{[\s\S]*?\}, \[teamId\]\)/.exec(view)?.[0]
    expect(refetch, 'the refetch callback should exist').toBeTruthy()
    expect(refetch).toContain('catch')
    expect(refetch).toContain('setData')
    // The interval tick calls refetch; the only invalidate left is the
    // errorComponent's explicit Retry (which re-runs the loader on purpose).
    const tick = /setInterval\(\s*\(\) => \{[\s\S]*?\},\s*anyRunning/.exec(view)?.[0]
    expect(tick, 'the poll interval should exist').toBeTruthy()
    expect(tick).toContain('void refetch()')
    expect(tick).not.toContain('invalidate')
  })

  it('team switch NAVIGATES to /t/<id>, never router.invalidate', () => {
    // The dashboard renders from its own fetch-then-set state (seeded once from
    // the loader), so router.invalidate would leave the visible data stale. Phase
    // 2: switching NAVIGATES to the team's explicit URL (the loader re-scopes),
    // and the /t/$teamId route re-seeds via key={teamId}.
    expect(view).toContain('<TeamSwitcher data={teams} />')
    expect(teamRoute).toContain('key={loaded!.teamId}')
    expect(switcher).toContain("to: '/t/$teamId'")
    expect(switcher).not.toContain('useRouter')
    expect(switcher).not.toContain('invalidate()')
  })
})

describe('dashboard bundle shelf layout', () => {
  it('renders the BundleShelf in the hero, not the old fan or carousel', () => {
    // Round 2: the one-bundle-at-a-time dial was replaced by a static shelf showing
    // every bundle at once.
    expect(view).toContain('<BundleShelf')
    expect(view).not.toContain('TemplateFan')
    expect(view).not.toContain('BundleDial')
    // Seeded from the loader's static-per-deploy bundles (never re-polled).
    expect(view).toContain('bundles={bundles}')
  })

  it('carries no carousel/dial CSS anymore (no spin, arrows, or clipped disc)', () => {
    // The shelf is plain flow layout: no oversized wheel to clip, so none of the
    // dial machinery should survive in the stylesheet.
    expect(appCss).not.toContain('.dial-')
    expect(appCss).not.toMatch(/@property\s+--rot/)
  })

  it('splits bundles into balanced rows of up to three, larger row on top', () => {
    // The layout rule is data-driven (splitRows in BundleShelf.tsx): ceil-first so the
    // LARGER row sits on top — the captain's 5 -> 3+2 example, generalizing to any count.
    const shelf = readFileSync(
      fileURLToPath(new URL('../components/BundleShelf.tsx', import.meta.url)),
      'utf8',
    )
    expect(shelf).toContain('splitRows(bundles, 3)')
    expect(shelf).toMatch(/Math\.ceil\(\(items\.length - at\) \/ \(rowCount - r\)\)/)
    // Row containers wrap so no bundle count can widen the page.
    expect(shelf).toContain('flex flex-wrap')
  })
})
