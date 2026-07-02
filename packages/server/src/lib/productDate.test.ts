import { describe, expect, it } from 'vitest'
import { globToRegExp, matchArtifacts, newestMatch, parseFilenameDate, productDate } from './productDate'

describe('parseFilenameDate', () => {
  it('parses the ISO-ish filename patterns', () => {
    expect(parseFilenameDate('reports/digest-2026-07-01.md')).toBe('2026-07-01')
    expect(parseFilenameDate('brief_2026_07_01.md')).toBe('2026-07-01')
    expect(parseFilenameDate('snap-20260701.png')).toBe('2026-07-01')
    expect(parseFilenameDate('workflow-setup-2026-06-25.md')).toBe('2026-06-25')
  })

  it('rejects non-dates and digit runs that merely look like dates', () => {
    expect(parseFilenameDate('notes/methodology.md')).toBeNull()
    expect(parseFilenameDate('report-2026-13-40.md')).toBeNull() // no month 13
    expect(parseFilenameDate('report-2026-02-30.md')).toBeNull() // not a real day
    expect(parseFilenameDate('hash-12026070199.bin')).toBeNull() // embedded in a longer number
    expect(parseFilenameDate('mixed-2026-07_01.md')).toBeNull() // inconsistent separator
  })

  it('dates by the BASENAME only (a dated directory does not date the file)', () => {
    expect(parseFilenameDate('2026-06-01/notes.md')).toBeNull()
  })

  it('skips an invalid candidate and keeps scanning', () => {
    expect(parseFilenameDate('v2026-99-99-then-2026-07-01.md')).toBe('2026-07-01')
  })
})

describe('productDate', () => {
  it('prefers the filename date and reports the source', () => {
    expect(productDate({ path: 'reports/digest-2026-07-01.md', updatedAt: '2026-07-02T09:12:00Z' })).toEqual({
      date: '2026-07-01',
      source: 'filename',
    })
  })

  it('falls back to sync time when the filename has no date', () => {
    const d = productDate({ path: 'notes/methodology.md', updatedAt: '2026-06-12T09:14:00Z' })
    expect(d.source).toBe('sync')
    expect(d.date).toMatch(/^2026-06-1[12]$/) // local day of the sync instant
  })
})

describe('globToRegExp / matchArtifacts', () => {
  const files = [
    { path: 'reports/digest-2026-07-01.md', updatedAt: '2026-07-01T09:00:00Z' },
    { path: 'reports/digest-2026-07-02.md', updatedAt: '2026-07-02T09:00:00Z' },
    { path: 'reports/archive/digest-2026-01-01.md', updatedAt: '2026-01-01T09:00:00Z' },
    { path: 'notes/methodology.md', updatedAt: '2026-06-12T09:00:00Z' },
    { path: 'README.md', updatedAt: '2026-06-01T09:00:00Z' },
  ]

  it('* stays within a path segment', () => {
    const m = matchArtifacts(files, 'reports/digest-*.md')
    expect(m.map((f) => f.path)).toEqual(['reports/digest-2026-07-01.md', 'reports/digest-2026-07-02.md'])
  })

  it('a pattern without a slash matches basenames anywhere', () => {
    const m = matchArtifacts(files, '*.md')
    expect(m).toHaveLength(5)
  })

  it('escapes regex metacharacters in the pattern', () => {
    expect(globToRegExp('a+b.md').test('a+b.md')).toBe(true)
    expect(globToRegExp('a+b.md').test('aab.md')).toBe(false)
  })

  it('no pattern selects everything', () => {
    expect(matchArtifacts(files)).toHaveLength(5)
  })
})

describe('newestMatch', () => {
  it('picks by filename date, so an old file that re-synced last never wins', () => {
    const files = [
      { path: 'reports/digest-2026-07-02.md', updatedAt: '2026-07-02T09:00:00Z' },
      // Older by filename, but synced most recently (e.g. a touch/re-sync):
      { path: 'reports/digest-2026-06-01.md', updatedAt: '2026-07-03T12:00:00Z' },
    ]
    expect(newestMatch(files, 'reports/digest-*.md')?.path).toBe('reports/digest-2026-07-02.md')
  })

  it('breaks date ties by sync time and returns undefined for no match', () => {
    const files = [
      { path: 'a-2026-07-01.md', updatedAt: '2026-07-01T08:00:00Z' },
      { path: 'b-2026-07-01.md', updatedAt: '2026-07-01T09:00:00Z' },
    ]
    expect(newestMatch(files)?.path).toBe('b-2026-07-01.md')
    expect(newestMatch(files, 'nope-*.md')).toBeUndefined()
  })
})
