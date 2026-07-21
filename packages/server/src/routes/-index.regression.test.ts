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

describe('dashboard bundle dial layout', () => {
  it('renders the BundleDial in the hero, not the old flat TemplateFan', () => {
    // The template fan was replaced by the rotating stage-select dial.
    expect(view).toContain('<BundleDial')
    expect(view).not.toContain('TemplateFan')
    // The dial is seeded from the loader's static-per-deploy bundles (never re-polled).
    expect(view).toContain('bundles={bundles}')
  })

  it('clips the oversized disc so no page scroll is introduced (the hard rule)', () => {
    // The wheel is a huge disc (2 x --dial-r); the stage MUST clip it (overflow:hidden)
    // with a bounded height, so the disc never widens or lengthens the page. This is
    // the dial's equivalent of the fan's flex-wrap guarantee.
    const stage = /\.dial-stage\s*\{[\s\S]*?\}/.exec(appCss)?.[0]
    expect(stage, 'the .dial-stage rule should exist').toBeTruthy()
    expect(stage).toContain('overflow: hidden')
    expect(stage).toMatch(/height:\s*\d+px/)
  })

  it('drives the spin via the registered @property --rot (transitionable angle)', () => {
    // The rotation angle is a registered custom property so the ~0.6s ease-out spin
    // animates; reduced-motion jumps instantly.
    expect(appCss).toMatch(/@property\s+--rot/)
    expect(appCss).toContain('prefers-reduced-motion')
  })
})
