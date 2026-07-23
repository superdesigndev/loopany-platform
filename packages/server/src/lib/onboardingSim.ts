/**
 * The onboarding SIMULATION gate — the ONE source of truth for whether the
 * dev-only "simulate a machine connecting / a loop being created" shim is live.
 *
 * The captain must be able to click the whole first-run flow through locally
 * without a real second machine, so a dev shim can fire the machine-connected and
 * loop-created events on cue. That shim is a DEV-ONLY affordance and MUST be
 * unreachable in a production build.
 *
 * Two independent guards, AND-ed, so a stray env var can never open it in prod:
 *   1. NODE_ENV must not be "production" (a prod build always sets it), and
 *   2. the explicit opt-in `LOOPANY_ONBOARDING_SIM` must be truthy.
 *
 * Pure, dependency-free, leaf module: imported by both the client-facing config
 * (`getConfig`, which surfaces the flag so the sim buttons only render when it's
 * on) and the server-side sim handlers (which refuse to act when it's off), so
 * the UI affordance and the server effect can never disagree.
 */
export function onboardingSimEnabled(): boolean {
  // A production build is off unconditionally — the flag is inert there.
  if (process.env.NODE_ENV === 'production') return false
  const flag = process.env.LOOPANY_ONBOARDING_SIM?.trim().toLowerCase()
  return flag === '1' || flag === 'on' || flag === 'true' || flag === 'yes'
}
