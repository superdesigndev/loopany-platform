/**
 * DEV-ONLY onboarding simulation shim.
 *
 * The first-run wizard advances on DETECTED reality: the machine step completes
 * when a daemon actually polls (`machineStatus.online`), and the loop step
 * completes when a real loop record lands (`claimStatus.done`). To let the captain
 * click that whole flow locally without a second machine, these two server fns fire
 * exactly those real signals on cue — they write the SAME store rows a real daemon
 * would, so the detection paths the wizard polls are 100% real; only the trigger is
 * simulated.
 *
 * Both are hard-gated by `onboardingSimEnabled()` (dev build AND explicit env
 * opt-in) and refuse to act otherwise, so a production build can never reach them.
 * The client only renders the buttons that call these when `getConfig().onboardingSim`
 * is true — the same gate — so the affordance and the effect can't disagree.
 */
import { createServerFn } from '@tanstack/react-start'
import * as store from '../db/store.js'
import { ensureServer } from './boot.js'
import { onboardingSimEnabled } from '../lib/onboardingSim.js'
import { HOUSEKEEPER_LOOP } from './onboardingHousekeeper.js'

/** Simulate the daemon coming online: stamp the pending machine row exactly as a
 *  real first poll would, so the wizard's `machineStatus` poll flips to connected. */
export const simulateMachineConnect = createServerFn({ method: 'POST' })
  .validator((machineId: string) => machineId)
  .handler(async ({ data: machineId }): Promise<{ ok: boolean; error?: string }> => {
    if (!onboardingSimEnabled()) return { ok: false, error: 'simulation disabled' }
    await ensureServer()
    const machine = await store.getMachine(machineId)
    if (!machine) return { ok: false, error: 'machine not found' }
    await store.updateMachine(machineId, {
      online: true,
      lastSeen: new Date().toISOString(),
      hostname: machine.hostname ?? 'sim-macbook',
      platform: machine.platform ?? 'darwin',
      arch: machine.arch ?? 'arm64',
      daemonVersion: machine.daemonVersion ?? 'sim',
    })
    return { ok: true }
  })

/** Simulate the coding agent building the Housekeeper loop: create a real loop
 *  record on the machine via the SAME gateway path a daemon uses, fulfilling the
 *  claim so the wizard's `claimStatus` poll flips to done and the dashboard shows
 *  the loop. `token` is the machine's device token (held client-side from the
 *  connect step); `claim` is the wizard's mint-claim token. */
export const simulateLoopCreated = createServerFn({ method: 'POST' })
  .validator((d: { token: string; claim: string }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; id?: string; error?: string }> => {
    if (!onboardingSimEnabled()) return { ok: false, error: 'simulation disabled' }
    const { gateway } = await ensureServer()
    // The faithful path: gateway.createLoop validates, schedules, and fulfills the
    // claim (so claimStatus resolves) exactly as a real `loopany new` would.
    const res = await gateway.createLoop(data.token, { ...HOUSEKEEPER_LOOP, claim: data.claim })
    if (res.status !== 200) {
      const body = res.body as { error?: string }
      return { ok: false, error: body?.error ?? `create failed (${res.status})` }
    }
    const body = res.body as { id?: string }
    return { ok: true, id: body?.id }
  })

/** A plausible Housekeeper first-run report, so the Loop page shows real content
 *  when the captain plays the arc without a live agent. */
const SEEDED_FIRST_REPORT = [
  'Ran the first housekeeping pass.',
  '',
  'Removed an unused helper module (`src/legacy/priceUtils.ts`) and two stale docs — a 102-line net reduction — in a fresh worktree off `main`. Build, tests, and runtime checks all stayed green, so the change was kept.',
  '',
  'Opened PR #1 with the cleanup and refreshed the dashboard. Cleanliness score: 62 → 68.',
].join('\n')

/** Simulate the loop's FIRST run completing with a seeded report, so the wizard's
 *  first-run detection flips to done and the Loop page shows a real result. Completes
 *  the immediate pending run when present, else writes a finished exec run. */
export const simulateFirstRun = createServerFn({ method: 'POST' })
  .validator((loopId: string) => loopId)
  .handler(async ({ data: loopId }): Promise<{ ok: boolean; runId?: string; error?: string }> => {
    if (!onboardingSimEnabled()) return { ok: false, error: 'simulation disabled' }
    await ensureServer()
    const loop = await store.getLoop(loopId)
    if (!loop) return { ok: false, error: 'loop not found' }
    const seeded = {
      phase: 'done' as const,
      outcome: 'exec' as const,
      status: 'new' as const,
      message: SEEDED_FIRST_REPORT,
      durationMs: 47_000,
      state: { cleanups: 1, score: 68 },
      ts: new Date().toISOString(),
    }
    // Prefer completing the immediate pending run (what runNow created); else seed one.
    const open = await store.openRunsForLoop(loopId)
    const pending = open[0]
    if (pending) {
      const r = await store.updateRun(pending.id, seeded)
      return { ok: true, runId: r?.id ?? pending.id }
    }
    const r = await store.addRun({ loopId, userId: loop.userId, machineId: loop.machineId, role: 'exec', ...seeded })
    return { ok: true, runId: r.id }
  })

/** Simulate binding a notification channel (+ a successful test ping) so the "Get
 *  notified" step is playable without a real workspace. Creates a real (demo) channel
 *  row so it also shows in the dashboard's Notifications manager. */
export const simulateNotifyBind = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ ok: boolean; id?: string; name?: string; error?: string }> => {
    if (!onboardingSimEnabled()) return { ok: false, error: 'simulation disabled' }
    await ensureServer()
    const { requestScope } = await import('../auth.js')
    const { teamId } = await requestScope()
    const name = 'Demo Slack · #loopany'
    const ch = await store.createChannel({
      teamId,
      type: 'slack',
      name,
      config: { token: 'xoxb-demo-onboarding', channel: '#loopany' },
    })
    return { ok: true, id: ch.id, name }
  })
