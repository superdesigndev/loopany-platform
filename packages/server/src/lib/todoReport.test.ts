// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { markdownToReportDoc, wrapReportHtml, REPORT_CSS } from './todoReport'

describe('wrapReportHtml (pure doc wrap)', () => {
  it('produces a self-contained HTML document with the embedded stylesheet', () => {
    const doc = wrapReportHtml('<p>hello</p>')
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<style>')
    expect(doc).toContain(REPORT_CSS.trim().slice(0, 20))
    expect(doc).toContain('<article class="report"><p>hello</p></article>')
  })

  it('renders front-matter title/date as an escaped header', () => {
    const doc = wrapReportHtml('<p>body</p>', { title: 'A & B <x>', date: '2026-07-23', type: 'report' })
    expect(doc).toContain('A &amp; B &lt;x&gt;')
    expect(doc).toContain('report · 2026-07-23')
    // The header sits before the body.
    expect(doc.indexOf('rpt-title')).toBeLessThan(doc.indexOf('<p>body</p>'))
  })

  it('omits the header element when there is no front matter', () => {
    expect(wrapReportHtml('<p>x</p>')).not.toContain('<header')
  })
})

describe('markdownToReportDoc (markdown → report document)', () => {
  it('renders markdown into the report body', () => {
    const doc = markdownToReportDoc('# Title\n\nSome **bold** text\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(doc).toContain('<h1>Title</h1>')
    expect(doc).toContain('<strong>bold</strong>')
    expect(doc).toContain('<table>')
  })

  it('strips leading front matter and surfaces it as a header', () => {
    const doc = markdownToReportDoc('---\ntitle: Weekly\ndate: 2026-07-23\n---\n\n# Body heading\n')
    expect(doc).toContain('rpt-title')
    expect(doc).toContain('Weekly')
    // The `---` fence must not render as an <hr> in the body.
    expect(doc).toContain('<h1>Body heading</h1>')
  })

  it('SANITIZES the report — a script/onerror in the source never survives', () => {
    const doc = markdownToReportDoc('# Report\n\n<script>window.__pwn=1</script>\n\n<img src=x onerror="alert(1)">')
    expect(doc).not.toContain('<script>')
    expect(doc).not.toContain('window.__pwn')
    expect(doc).not.toContain('onerror')
  })
})
