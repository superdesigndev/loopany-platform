import { expect, test } from 'vitest'
import { failureMessage } from './notify'

test('a running run interrupted mid-flight reads as calmly asleep, not a scary failure', () => {
  const m = failureMessage('machine timed out / disconnected')
  expect(m).toMatch(/asleep|offline/i)
  expect(m).toMatch(/in progress|interrupted/i)
  expect(m).toMatch(/resumes automatically/i)
  expect(m).not.toMatch(/📵/) // no alarming "no signal" icon
})

test('a scheduled run skipped while asleep names sleep as the likely cause', () => {
  for (const reason of ['machine offline', 'run never claimed']) {
    const m = failureMessage(reason)
    expect(m).toMatch(/asleep/i)
    expect(m).toMatch(/skipped/i)
    expect(m).toMatch(/resumes automatically/i)
    expect(m).not.toMatch(/📵/)
  }
})

test('a genuine run failure still surfaces the real reason', () => {
  expect(failureMessage('claude reported an error')).toBe('⚠️ Run failed — claude reported an error')
  expect(failureMessage(null)).toBe('⚠️ Run failed.')
})
