import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFormExec } from './LoopForm'

const formSrc = readFileSync(fileURLToPath(new URL('./LoopForm.tsx', import.meta.url)), 'utf8')

/**
 * Manual Edit → Model used to no-op when workdir was empty: read() only built
 * `exec` when workdir was non-empty, and patchJob only writes model via
 * `p.exec?.model`. Clearing model was also broken (empty coerced to undefined).
 */
describe('LoopForm.read exec wiring', () => {
  it('always builds exec via buildFormExec (not gated on workdir)', () => {
    // The old bug: `const exec = f.workdir.trim() ? { ... model } : undefined`
    expect(formSrc).not.toMatch(/const exec = f\.workdir\.trim\(\)\s*\?/)
    expect(formSrc).toMatch(/exec:\s*buildFormExec\(f\)/)
    // Cleared model must stay a defined string, never `|| undefined`
    const helper = formSrc.slice(formSrc.indexOf('export function buildFormExec'))
    const body = helper.slice(0, helper.indexOf('export interface') > 0 ? helper.indexOf('export interface') : 400)
    expect(body).not.toMatch(/model:.*\|\|\s*undefined/)
  })
})

describe('buildFormExec (manual form save payload)', () => {
  it('emits exec.model when workdir is empty so model edits still patch', () => {
    const exec = buildFormExec({
      workdir: '',
      model: 'claude-opus-4-20250514',
      allowControl: true,
    })
    expect(exec).toEqual({
      executor: 'claude',
      workdir: '',
      model: 'claude-opus-4-20250514',
      allowControl: true,
    })
    // patchJob gates on !== undefined — a defined empty string is what clears
    expect(exec.model).toBeDefined()
  })

  it('emits a defined empty model string so clearing model is patchable', () => {
    const exec = buildFormExec({
      workdir: '/tmp/proj',
      model: '   ',
      allowControl: false,
    })
    expect(exec.model).toBe('')
    expect(exec.model).toBeDefined()
    expect(exec.workdir).toBe('/tmp/proj')
    expect(exec.allowControl).toBe(false)
  })

  it('trims workdir and model but never drops the exec object', () => {
    const exec = buildFormExec({
      workdir: '  /home/me/app  ',
      model: '  sonnet  ',
      allowControl: true,
    })
    expect(exec.workdir).toBe('/home/me/app')
    expect(exec.model).toBe('sonnet')
    expect(exec.executor).toBe('claude')
  })

  it('still carries allowControl with empty workdir and empty model', () => {
    const exec = buildFormExec({ workdir: '', model: '', allowControl: false })
    expect(exec).toEqual({
      executor: 'claude',
      workdir: '',
      model: '',
      allowControl: false,
    })
  })
})
