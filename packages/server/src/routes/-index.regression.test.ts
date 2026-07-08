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
// switcher, template fan) moved to the shared DashboardView (rendered by both `/`
// in open mode and `/t/$teamId`), so the body guards read from there.
const src = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8')
const teamRoute = readFileSync(fileURLToPath(new URL('./t.$teamId.tsx', import.meta.url)), 'utf8')
const view = readFileSync(
  fileURLToPath(new URL('../components/DashboardView.tsx', import.meta.url)),
  'utf8',
)
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
    expect(view).toContain('<TeamSwitcher data={teams} onSwitch={refresh} />')
    expect(teamRoute).toContain('key={loaded!.teamId}')
    expect(switcher).toContain("to: '/t/$teamId'")
    expect(switcher).not.toContain('useRouter')
    expect(switcher).not.toContain('invalidate()')
  })
})

describe('dashboard template fan layout', () => {
  it('fan cards wrap and stay fixed-width - no template count may widen the page', () => {
    // The hero template fan grows with the registry. Per the
    // no-page-level-horizontal-scroll rule each fan ROW must WRAP at narrow
    // widths (flex-wrap on the row container) and each card is a fixed narrow
    // width (w-[..px] shrink-0), so no count of templates can overflow the
    // viewport - extra cards fold into a second row instead.
    const fan = /<div key=\{r\} className="flex flex-wrap[^"]*">[\s\S]*?row\.map/.exec(view)?.[0]
    expect(fan, 'the wrapping fan row should contain the template cards').toBeTruthy()
    const card = /row\.map\([\s\S]*?className="([^"]*)"/.exec(view)?.[1]
    expect(card, 'the template card should have a className').toBeTruthy()
    expect(card).toMatch(/\bw-\[\d+px\]/)
    expect(card).toContain('shrink-0')
  })

  it('splits 6+ templates into balanced rows - a full row never strands one orphan card', () => {
    // With 7 templates a single flex-wrap row broke 6/1 at common desktop
    // widths - a lone centered card under a full row reads as a bug. The fan
    // must pre-split into balanced rows (max 4 per row) instead of letting
    // flex-wrap decide the break point.
    expect(view).toMatch(/templates\.length <= 5 \? 1 : Math\.ceil\(templates\.length \/ 4\)/)
    // Remaining cards divide evenly across remaining rows (7 -> 4/3, not 4/3/0).
    expect(view).toMatch(/Math\.ceil\(\(templates\.length - at\) \/ \(rowCount - r\)\)/)
  })
})
