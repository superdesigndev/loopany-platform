import { describe, expect, it } from 'vitest'
import { groupTranscript } from './transcript'
import type { TranscriptStep } from '../types'

describe('groupTranscript', () => {
  it('attaches result steps to the preceding tool/text step', () => {
    const steps: TranscriptStep[] = [
      { kind: 'text', text: 'thinking' },
      { kind: 'tool', name: 'Bash', input: 'ls' },
      { kind: 'result', text: 'a\nb' },
      { kind: 'result', text: 'more' },
      { kind: 'text', text: 'done' },
    ]
    const items = groupTranscript(steps)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'text', text: 'thinking', results: [] })
    expect(items[1]).toMatchObject({ kind: 'tool', name: 'Bash', input: 'ls', results: ['a\nb', 'more'] })
    expect(items[2]).toMatchObject({ kind: 'text', text: 'done', results: [] })
  })

  it('never drops a leading orphan result (surfaces it as its own item)', () => {
    const items = groupTranscript([{ kind: 'result', text: 'orphan' }])
    expect(items).toEqual([{ kind: 'text', text: 'orphan', results: [] }])
  })

  it('returns an empty list for no steps', () => {
    expect(groupTranscript([])).toEqual([])
  })
})
