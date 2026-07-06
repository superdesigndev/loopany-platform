import { expect, test } from 'vitest'
import { MACHINE_ASLEEP_TTL_MS, MACHINE_ONLINE_TTL_MS, machinePresence } from './machinePresence'

const now = 1_000_000_000_000
const ago = (ms: number) => new Date(now - ms).toISOString()

test('online only when the flag is set AND the stamp is fresh', () => {
  expect(machinePresence(true, ago(5_000), now)).toBe('online')
  // Fresh stamp but the stored flag is stale (sweep lag) → not online.
  expect(machinePresence(false, ago(5_000), now)).toBe('asleep')
})

test('recently-seen-but-not-polling reads as asleep, not offline', () => {
  expect(machinePresence(true, ago(MACHINE_ONLINE_TTL_MS + 1_000), now)).toBe('asleep')
  expect(machinePresence(true, ago(3 * 60 * 60 * 1000), now)).toBe('asleep') // 3h
})

test('gone past the asleep window reads as offline', () => {
  expect(machinePresence(true, ago(MACHINE_ASLEEP_TTL_MS + 1_000), now)).toBe('offline')
})

test('never seen is offline', () => {
  expect(machinePresence(true, null, now)).toBe('offline')
  expect(machinePresence(false, undefined, now)).toBe('offline')
  expect(machinePresence(true, 'not-a-date', now)).toBe('offline')
})
