import { describe, expect, it } from 'vitest'
import { diffStat, parseUnifiedDiff } from './diff'

describe('parseUnifiedDiff', () => {
  it('classifies add/del/context without mis-reading the +++/--- headers', () => {
    const diff = ['--- a/file.txt', '+++ b/file.txt', '@@ -1,2 +1,2 @@', ' keep', '-old line', '+new line'].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'context', 'del', 'add'])
    // markers are stripped from content, gutter carries the glyph
    expect(lines[3]).toMatchObject({ text: 'keep', gutter: '' })
    expect(lines[4]).toMatchObject({ text: 'old line', gutter: '-' })
    expect(lines[5]).toMatchObject({ text: 'new line', gutter: '+' })
  })

  it('does not emit a spurious empty final line for a trailing newline', () => {
    expect(parseUnifiedDiff('+a\n+b\n')).toHaveLength(2)
    expect(parseUnifiedDiff('')).toHaveLength(0)
  })

  it('treats "\\ No newline at end of file" and blank lines as neutral context', () => {
    const lines = parseUnifiedDiff('+a\n\\ No newline at end of file')
    expect(lines[1]).toMatchObject({ kind: 'context' })
  })

  it('counts added/removed content lines (ignoring headers)', () => {
    const diff = ['+++ b/x', '@@ -1 +1,2 @@', '-gone', '+one', '+two', ' ctx'].join('\n')
    expect(diffStat(parseUnifiedDiff(diff))).toEqual({ added: 2, removed: 1 })
  })

  it('keeps "--"/"++"-leading content lines inside a hunk as del/add, not meta', () => {
    const diff = [
      '--- a/task.md',
      '+++ b/task.md',
      '@@ -1,3 +1,3 @@',
      '----',
      '-- comment',
      '+++x',
      ' body',
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'del', 'del', 'add', 'context'])
    expect(lines[3]).toMatchObject({ kind: 'del', text: '---', gutter: '-' })
    expect(lines[4]).toMatchObject({ kind: 'del', text: '- comment', gutter: '-' })
    expect(lines[5]).toMatchObject({ kind: 'add', text: '++x', gutter: '+' })
    expect(diffStat(lines)).toEqual({ added: 1, removed: 2 })
  })

  it('classifies the createTwoFilesPatch "Index:"/"===" preamble as meta', () => {
    const diff = [
      'Index: task.md',
      '===================================================================',
      '--- task.md',
      '+++ task.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines.slice(0, 4).map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta'])
    expect(lines[5]).toMatchObject({ kind: 'del' })
    expect(lines[6]).toMatchObject({ kind: 'add' })
  })
})
