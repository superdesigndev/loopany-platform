// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactBody } from './artifactView'
import type { ArtifactSummary } from '../types'

/**
 * The shared artifact content viewer. The load-bearing case is HTML: it must
 * render in a STRICT sandboxed iframe (allow-scripts, NEVER allow-same-origin)
 * so user-machine-synced markup can't reach the app's session/origin. The image
 * case must render via the hardened inline route (never inlined markup), and
 * oversize/binary must degrade to a note/download rather than an empty pane.
 */

vi.mock('../server/loopApi', () => ({
  getArtifact: vi.fn(async ({ data }: { data: { path: string } }) => {
    if (/\.html?$/.test(data.path))
      return { text: '<h1>Report</h1><script>document.title=document.cookie</script>' }
    if (/\.(md|markdown)$/.test(data.path)) return { text: '# Heading\n\nsome **bold** prose' }
    return { text: 'plain text body' }
  }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (overrides: Partial<ArtifactSummary> & { path: string }): ArtifactSummary => ({
  size: 100,
  updatedAt: '2026-07-07T08:00:00.000Z',
  binary: false,
  oversize: false,
  meta: null,
  ...overrides,
})

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

async function mount(f: ArtifactSummary): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(ArtifactBody, { loopId: 'loop-1', file: f }))
  })
  return host
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = null
  host = null
})

describe('ArtifactBody - HTML', () => {
  it('renders in a sandboxed iframe with allow-scripts but NEVER allow-same-origin', async () => {
    const el = await mount(file({ path: 'reports/2026-07-07-run-lifecycle.html' }))
    const iframe = el.querySelector('iframe')
    expect(iframe, 'an iframe should render the HTML').toBeTruthy()
    const sandbox = iframe!.getAttribute('sandbox') ?? ''
    // The isolation invariant: scripts may run, but the frame must stay in an
    // opaque origin (no same-origin) so it can't read cookies or reach parent.
    expect(sandbox.split(/\s+/)).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    // The markup rides via srcdoc (off any navigable app-origin URL).
    expect(iframe!.getAttribute('srcdoc') ?? '').toContain('<h1>Report</h1>')
  })

  it('toggles to a raw Source view (never as live app-origin DOM)', async () => {
    const el = await mount(file({ path: 'a.html' }))
    const source = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Source')
    expect(source, 'a Source toggle should exist for HTML').toBeTruthy()
    await act(async () => source!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // Source mode shows the raw markup as text in a <pre> - NOT parsed into the DOM.
    const pre = el.querySelector('pre')
    expect(pre?.textContent).toContain('<script>')
    expect(el.querySelector('iframe')).toBeNull()
    // The raw <script> is inert text, never an executable element in our tree.
    expect(el.querySelector('script')).toBeNull()
  })
})

describe('ArtifactBody - image', () => {
  it('renders an <img> pointed at the hardened inline route, no markup inlined', async () => {
    const el = await mount(file({ path: 'shots/diagram.png', binary: true }))
    const img = el.querySelector('img')
    expect(img, 'an <img> should render the image').toBeTruthy()
    expect(img!.getAttribute('src')).toBe('/api/artifact/loop-1/shots/diagram.png?view=inline')
  })

  it('an SVG renders as an <img> (never inlined into the app DOM)', async () => {
    const el = await mount(file({ path: 'logo.svg' }))
    const img = el.querySelector('img')
    expect(img).toBeTruthy()
    expect(img!.getAttribute('src')).toContain('logo.svg?view=inline')
    // Not inlined: no <svg> node in the app tree.
    expect(el.querySelector('svg')).toBeNull()
  })
})

describe('ArtifactBody - markdown / oversize / binary', () => {
  it('renders markdown as formatted prose', async () => {
    const el = await mount(file({ path: 'notes/report.md' }))
    // The shared markdown pipeline emits a real heading node, not raw hashes.
    expect(el.querySelector('.taskmd h1')?.textContent).toContain('Heading')
  })

  it('oversize (metadata-only) shows a no-bytes note, not an empty pane', async () => {
    const el = await mount(file({ path: 'huge.html', oversize: true }))
    expect(el.textContent).toMatch(/metadata only/i)
    expect(el.querySelector('iframe')).toBeNull()
  })

  it('a genuinely binary non-image offers a download', async () => {
    const el = await mount(file({ path: 'data.bin', binary: true }))
    const a = el.querySelector('a[download]') as HTMLAnchorElement | null
    expect(a?.getAttribute('href')).toBe('/api/artifact/loop-1/data.bin')
    expect(el.textContent).toMatch(/not previewable/i)
  })
})
