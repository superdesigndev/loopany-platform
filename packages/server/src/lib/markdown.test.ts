// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders inline markdown (bold / code / links / lists)', () => {
    const html = renderMarkdown('**bold** and `code` and [link](https://x.test)\n\n- one\n- two')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('href="https://x.test"')
    expect(html).toContain('<li>one</li>')
  })

  it('strips scripts and event handlers (allowlist sanitizer)', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script> [x](javascript:alert(3))')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })
})
