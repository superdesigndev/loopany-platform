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
// switcher, bundle carousel) moved to the shared DashboardView (rendered by both `/`
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

const carousel = readFileSync(
  fileURLToPath(new URL('../components/BundleCarousel.tsx', import.meta.url)),
  'utf8',
)

describe('dashboard bundle carousel', () => {
  it('renders the BundleCarousel in the hero, not the old fan/dial/shelf', () => {
    // Round 3: a plain auto-playing carousel (one bundle at a time), NOT the round-1
    // rotating disc nor the round-2 all-at-once shelf.
    expect(view).toContain('<BundleCarousel')
    expect(view).not.toContain('TemplateFan')
    expect(view).not.toContain('BundleDial')
    expect(view).not.toContain('BundleShelf')
    // Seeded from the loader's static-per-deploy bundles (never re-polled).
    expect(view).toContain('bundles={bundles}')
  })

  it('ships the template registry ONCE — bundles embed every member, so no second listTemplates', () => {
    // `listBundles()` already carries every TemplateInfo (thumb SVGs included); fetching
    // the flat list too duplicated ~90KB on every dashboard load and team switch.
    for (const s of [src, teamRoute]) expect(s).not.toContain('listTemplates')
    expect(view).not.toContain('templates: TemplateInfo[]')
    // The market deep-link resolves out of the bundles instead.
    expect(view).toContain('bundles.flatMap((b) => b.members)')
  })

  it('is a PLAIN slide carousel — a clipped viewport + translated track, no dial/spin', () => {
    // No page scroll: the viewport clips off-screen slides. No leftover rotating-disc
    // machinery (round-1 dial) survives in the stylesheet.
    const vp = /\.bundle-carousel-viewport\s*\{[\s\S]*?\}/.exec(appCss)?.[0]
    expect(vp, 'the .bundle-carousel-viewport rule should exist').toBeTruthy()
    expect(vp).toContain('overflow: hidden')
    expect(appCss).not.toContain('.dial-')
    expect(appCss).not.toMatch(/@property\s+--rot/)
  })

  it('auto-plays but honours reduced-motion and pauses on interaction', () => {
    // Auto-advance on an interval, disabled under reduced-motion and while paused
    // (hover/focus) or stopped (after a manual nav).
    expect(carousel).toContain('setInterval')
    expect(carousel).toContain('prefers-reduced-motion')
    expect(carousel).toMatch(/const autoplaying =[^\n]*!reduced[^\n]*!stopped/)
    // The slide tween is disabled under reduced-motion at the CSS layer.
    expect(appCss).toMatch(/prefers-reduced-motion[\s\S]*?\.bundle-carousel-track\s*\{\s*transition:\s*none/)
  })

  it('wraps the loop-card fan in rows of up to three WITHIN a bundle (3->[3], 4->[3,1], 5->[3,2])', () => {
    // The fill-first rule applies to the fanned loop cards inside one bundle (data-driven
    // splitRows, filling each row of up to 3 so the larger rows sit on top).
    expect(carousel).toContain('splitRows(bundle.members, 3)')
    expect(carousel).toMatch(/for \(let i = 0; i < items\.length; i \+= maxPerRow\)/)
    // Fan rows wrap so no loop count can widen the page.
    expect(carousel).toContain('flex flex-wrap')
  })

  it('CTA is exactly "Try this bundle" (no icons/prefix) and skipped for Others', () => {
    expect(carousel).toContain('Try this bundle')
    expect(carousel).not.toContain('Copy prompt · try this bundle')
    // The individually-set-up category renders no bundle CTA.
    expect(carousel).toContain('!bundle.individual &&')
    // The single-loop affordance stays.
    expect(carousel).toContain('or click a loop to set it up alone')
  })
})
