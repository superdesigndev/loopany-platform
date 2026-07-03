// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import type { ArtifactSummary } from '../types'
import { LoopFilesPanel } from './LoopFilesPanel'
import { getArtifacts, getArtifact } from '../server/loopApi'

// The panel fetches its file list via getArtifacts and a body via getArtifact.
vi.mock('../server/loopApi', () => ({
  getArtifacts: vi.fn(async () => [] as ArtifactSummary[]),
  getArtifact: vi.fn(async () => ({ text: 'body' })),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (path: string, meta: ArtifactSummary['meta'] = null): ArtifactSummary => ({
  path,
  size: 42,
  updatedAt: '2026-07-01T08:00:00.000Z',
  binary: false,
  oversize: false,
  meta,
})

/** Mount the panel, resolve the mocked artifact list, return the rendered HTML. */
async function mount(artifacts: ArtifactSummary[], props: Partial<Parameters<typeof LoopFilesPanel>[0]> = {}) {
  vi.mocked(getArtifacts).mockResolvedValue(artifacts)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      createElement(LoopFilesPanel, {
        loopId: 'loop-1',
        taskFile: undefined,
        taskFileContent: null,
        taskFileSyncedAt: null,
        ...props,
      }),
    )
  })
  // flush the pending getArtifacts microtask
  await act(async () => {})
  const html = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return html
}

describe('LoopFilesPanel type/title chips', () => {
  it('renders a quiet type chip for a typed artifact', async () => {
    const html = await mount([file('ideas/one.md', { type: '待调研' })])
    expect(html).toContain('待调研')
    // The untyped extension tag ('md') is NOT shown when a type chip is.
    expect(html).toContain('ideas/one.md')
  })

  it('uses the front-matter title as the display name, keeping the path as a subline', async () => {
    const html = await mount([file('reports/r1.md', { title: 'Weekly Roundup', type: 'published' })])
    expect(html).toContain('Weekly Roundup')
    expect(html).toContain('reports/r1.md') // path still identifiable
    expect(html).toContain('published')
  })

  it('leaves an untyped artifact unchanged (extension tag, filename display)', async () => {
    const html = await mount([file('notes.md')])
    expect(html).toContain('notes.md')
    // The faint extension tag is the fallback for untyped rows.
    expect(html).toContain('>md<')
  })

  it('exempts the task file: it keeps its TASK chip even if its artifact carries meta', async () => {
    // The synced README is badged as the task; front matter must not override that.
    const html = await mount([file('README.md', { type: 'spec', title: 'Should Not Show' })], {
      taskFile: 'README.md',
      taskFileContent: '# spec',
    })
    expect(html).toContain('>Task<') // the task chip, not the "Task file" viewer caption
    expect(html).not.toContain('Should Not Show')
  })
})
