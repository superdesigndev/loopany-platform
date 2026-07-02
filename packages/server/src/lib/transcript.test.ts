import { describe, expect, it } from 'vitest'
import { groupTranscript, summarizeTool } from './transcript'
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

describe('summarizeTool', () => {
  it('surfaces the identifying arg (file path for a read, command for bash)', () => {
    expect(summarizeTool('{"file_path":"/a/b.md"}')).toBe('/a/b.md')
    expect(summarizeTool('{"command":"ls -la"}')).toBe('ls -la')
    expect(summarizeTool('{"pattern":"foo","path":"src"}')).toBe('src') // path outranks pattern
  })

  it('reads a short scalar/string payload as the summary itself', () => {
    expect(summarizeTool('"just a string"')).toBe('just a string')
    expect(summarizeTool('42')).toBe('42')
    expect(summarizeTool('plain text arg')).toBe('plain text arg')
  })

  it('returns null when there is nothing useful to show inline', () => {
    expect(summarizeTool('')).toBeNull()
    expect(summarizeTool(undefined)).toBeNull()
    expect(summarizeTool('{"weird":"key"}')).toBeNull() // no recognized key
    expect(summarizeTool('{}')).toBeNull()
    expect(summarizeTool('x'.repeat(200))).toBeNull() // long non-JSON blob
  })
})
