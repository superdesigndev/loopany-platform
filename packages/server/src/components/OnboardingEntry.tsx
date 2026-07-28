import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { markOnboardingDismissed, onboardingDismissed } from '../lib/onboardingState'

/**
 * The homepage's MINIMAL onboarding entry hook — deliberately its own component so
 * the dashboard body stays untouched (two other crews are reworking that surface).
 * It does two things:
 *   1. AUTO-STARTS the guided flow ONCE for a genuinely empty workspace (no loops,
 *      no machines) that hasn't been dismissed — marking it dismissed first so it
 *      never yanks the user back on a browser Back.
 *   2. Renders a quiet, always-available entry banner while the user has no loops,
 *      so a returning-but-not-onboarded user can still pick it up.
 * A user with any loop never sees it (`noLoops` is false).
 */
export function OnboardingEntry({
  teamId,
  noLoops,
  noMachines,
}: {
  teamId?: string
  noLoops: boolean
  noMachines: boolean
}) {
  const navigate = useNavigate()
  const teamKey = teamId ?? 'open'
  const firedRef = useRef(false)
  // Carry THIS dashboard's team into the wizard, so the minted machine + claim bind
  // to the team the banner was shown for. Without it the wizard falls back to the
  // last-used-team cookie, which can point elsewhere on a bookmarked/shared `/t/<id>`.
  const start = useCallback(
    () => navigate({ to: '/onboarding', search: teamId ? { team: teamId } : {} }),
    [navigate, teamId],
  )

  useEffect(() => {
    if (firedRef.current) return
    // Auto-start only for a fully empty workspace that hasn't been dismissed.
    if (noLoops && noMachines && !onboardingDismissed(teamKey)) {
      firedRef.current = true
      // Mark dismissed BEFORE navigating so Back doesn't re-trigger the redirect;
      // the banner below keeps it discoverable afterwards.
      markOnboardingDismissed(teamKey)
      void start()
    }
  }, [noLoops, noMachines, teamKey, start])

  if (!noLoops) return null

  return (
    <div className="mb-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-card border border-hairline bg-surface px-5 py-3 text-center shadow-card">
      <span className="text-body text-secondary">New to Loopany? Set up your first loop in a few guided steps.</span>
      <button
        onClick={() => void start()}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-display px-3.5 py-1.5 text-meta font-medium text-paper transition-opacity hover:opacity-85"
      >
        Guided setup →
      </button>
    </div>
  )
}
