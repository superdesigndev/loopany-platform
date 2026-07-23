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
