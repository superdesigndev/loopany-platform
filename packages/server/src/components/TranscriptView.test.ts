// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TranscriptView } from './TranscriptView'
import type { TranscriptStep } from '../types'

const render = (steps: TranscriptStep[]) => renderToStaticMarkup(createElement(TranscriptView, { steps }))

describe('TranscriptView', () => {
  it('renders assistant text as markdown, not raw text', () => {
    const html = render([{ kind: 'text', text: 'do **this** now' }])
    expect(html).toContain('<strong>this</strong>')
    expect(html).toContain('taskmd')
  })

  it('collapses a tool call to name + key-arg summary', () => {
    const html = render([{ kind: 'tool', name: 'Read', input: '{"file_path":"/a/b.md"}' }])
    expect(html).toContain('Read')
    expect(html).toContain('/a/b.md')
    // Compact summary + truncation guards against horizontal overflow.
    expect(html).toContain('truncate')
  })

  it('does not emit a bare RESULT label above outputs', () => {
    const html = render([
      { kind: 'tool', name: 'Bash', input: '{"command":"ls"}' },
      { kind: 'result', text: 'a\nb' },
    ])
    // The old redundant uppercase "result" label div is gone.
    expect(html).not.toMatch(/uppercase[^"]*">result</)
  })

  it('cycles per-turn marker color through the chart ramp', () => {
    const html = render([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ])
    expect(html).toContain('--color-chart-1')
    expect(html).toContain('--color-chart-2')
  })
})
