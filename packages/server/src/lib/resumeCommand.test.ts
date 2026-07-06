import { describe, expect, it } from 'vitest'
import { buildResumeCommand } from './resumeCommand'

describe('buildResumeCommand', () => {
  it('cds into the loop dir then resumes the exact session', () => {
    expect(buildResumeCommand({ sessionId: 'sess-abc123', dir: '/home/me/loopany/coffee' })).toBe(
      "cd '/home/me/loopany/coffee' && claude --resume sess-abc123",
    )
  })

  it('degrades to the bare resume command when the dir is unknown (no fabricated path)', () => {
    expect(buildResumeCommand({ sessionId: 'sess-abc123' })).toBe('claude --resume sess-abc123')
    expect(buildResumeCommand({ sessionId: 'sess-abc123', dir: null })).toBe('claude --resume sess-abc123')
    expect(buildResumeCommand({ sessionId: 'sess-abc123', dir: '' })).toBe('claude --resume sess-abc123')
  })

  it('quotes a dir with spaces', () => {
    expect(buildResumeCommand({ sessionId: 's1', dir: '/Users/me/My Projects/loop' })).toBe(
      "cd '/Users/me/My Projects/loop' && claude --resume s1",
    )
  })

  it("escapes an apostrophe in the dir so the command stays a single shell-safe string", () => {
    expect(buildResumeCommand({ sessionId: 's1', dir: "/Users/me/it's here" })).toBe(
      "cd '/Users/me/it'\\''s here' && claude --resume s1",
    )
  })

  it('has no trailing whitespace', () => {
    const c = buildResumeCommand({ sessionId: 's1', dir: '/a/b' })
    expect(c).toBe(c.trim())
  })
})
