// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopKanban } from './LoopKanban'
import type { ArtifactSummary } from '../types'

vi.mock('../server/loopApi', () => ({
  getArtifact: vi.fn(async () => ({ text: '# body\nhello from the card' })),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (path: string, meta: ArtifactSummary['meta'] = null, updatedAt = '2026-07-01T08:00:00.000Z'): ArtifactSummary => ({
  path,
  size: 10,
  updatedAt,
  binary: false,
  oversize: false,
  meta,
})

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(props: Parameters<typeof LoopKanban>[0]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopKanban, props))
  })
  return host
}

/** Click the card button whose visible title matches, then flush effects. */
async function clickCard(el: HTMLElement, title: string): Promise<void> {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(title))
  if (!btn) throw new Error(`no card titled "${title}"`)
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const base = { loopId: 'loop-1', columns: 'research,in-progress,done' as string | undefined }

describe('LoopKanban grouping', () => {
  it('renders declared columns and drops cards into the column equal to their type', async () => {
    const el = await mount({
      ...base,
      artifacts: [
        file('notes/a.md', { type: 'research', title: 'Alpha' }),
        file('notes/b.md', { type: 'done', title: 'Bravo' }),
      ],
    })
    const out = el.innerHTML
    expect(out).toContain('research')
    expect(out).toContain('in-progress')
    expect(out).toContain('done')
    expect(out).toContain('Alpha')
    expect(out).toContain('Bravo')
    // No overflow column when every type is declared.
    expect(out).not.toContain('Other')
  })

  it('collects a typed product whose type matches no column in a trailing Other column', async () => {
    const el = await mount({
      ...base,
      artifacts: [
        file('notes/a.md', { type: 'research', title: 'Alpha' }),
        file('notes/typo.md', { type: 'reserch', title: 'Typo' }), // typo → overflow
      ],
    })
    const out = el.innerHTML
    expect(out).toContain('Other')
    expect(out).toContain('Typo') // never silently dropped
  })

  it('de-duplicates repeated column names so a typo renders one column', async () => {
    const el = await mount({
      ...base,
      columns: 'research,research,done',
      artifacts: [file('notes/a.md', { type: 'research', title: 'Alpha' })],
    })
    const out = el.innerHTML
    // Exactly one 'research' column header (dedup), not two.
    expect(out.split('research').length - 1).toBe(1)
    // The single Alpha card is not duplicated across two columns.
    expect(out.split('Alpha').length - 1).toBe(1)
  })

  it('keeps a declared Other column separate from the automatic overflow bucket', async () => {
    const el = await mount({
      ...base,
      columns: 'research,Other',
      artifacts: [
        file('notes/a.md', { type: 'Other', title: 'Declared' }), // declared 'Other' column
        file('notes/typo.md', { type: 'reserch', title: 'Overflowed' }), // no column → overflow
      ],
    })
    const out = el.innerHTML
    // The declared card stays in its column and the overflow card is not merged into it.
    expect(out).toContain('Declared')
    expect(out).toContain('Overflowed')
    // Neither card is duplicated by an 'Other' key collision.
    expect(out.split('Declared').length - 1).toBe(1)
    expect(out.split('Overflowed').length - 1).toBe(1)
  })

  it('falls back to the filename when no title is set, and ignores untyped products', async () => {
    const el = await mount({
      ...base,
      artifacts: [
        file('notes/plain-note.md', { type: 'research' }), // no title → basename
        file('notes/untyped.md', { title: 'Has title but no type' }), // untyped → excluded
        file('notes/no-meta.md'), // meta null → excluded
      ],
    })
    const out = el.innerHTML
    expect(out).toContain('plain-note.md')
    expect(out).not.toContain('Has title but no type')
    expect(out).not.toContain('no-meta.md')
  })
})

describe('LoopKanban match + task-file scoping', () => {
  it('honors the match glob and excludes non-matching typed products', async () => {
    const el = await mount({
      ...base,
      match: 'notes/*.md',
      artifacts: [
        file('notes/in.md', { type: 'research', title: 'InScope' }),
        file('other/out.md', { type: 'research', title: 'OutOfScope' }),
      ],
    })
    const out = el.innerHTML
    expect(out).toContain('InScope')
    expect(out).not.toContain('OutOfScope')
  })

  it('always excludes the task file even when it carries a type', async () => {
    const el = await mount({
      ...base,
      taskFile: '/Users/me/work/loop/README.md',
      artifacts: [
        file('README.md', { type: 'research', title: 'The Spec' }),
        file('notes/a.md', { type: 'research', title: 'Alpha' }),
      ],
    })
    const out = el.innerHTML
    expect(out).toContain('Alpha')
    expect(out).not.toContain('The Spec')
  })
})

describe('LoopKanban card sort', () => {
  it('sorts within a column by date desc, then sync time desc', async () => {
    const el = await mount({
      ...base,
      artifacts: [
        file('notes/old.md', { type: 'research', title: 'Older', date: '2026-06-01' }),
        file('notes/new.md', { type: 'research', title: 'Newer', date: '2026-07-15' }),
      ],
    })
    const out = el.innerHTML
    // Newer (2026-07-15) card must appear before Older (2026-06-01) in DOM order.
    expect(out.indexOf('Newer')).toBeLessThan(out.indexOf('Older'))
    // A real date is shown on the card; a sync-only fallback is not.
    expect(out).toContain('2026-07-15')
  })
})

describe('LoopKanban review modal', () => {
  it('opens the card body in a modal on click and closes it again', async () => {
    const el = await mount({
      ...base,
      artifacts: [file('notes/a.md', { type: 'research', title: 'Alpha' })],
    })
    // Nothing reviewed yet — the modal (a body-level portal) isn't mounted.
    expect(document.body.innerHTML).not.toContain('hello from the card')
    await clickCard(el, 'Alpha')
    // Body fetched + rendered inside the portal, with the path in the head.
    expect(document.body.innerHTML).toContain('hello from the card')
    expect(document.body.innerHTML).toContain('notes/a.md')
    const close = [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Close',
    )
    if (!close) throw new Error('no modal close button')
    await act(async () => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.innerHTML).not.toContain('hello from the card')
  })
})

describe('LoopKanban authoring hint', () => {
  it('shows a hint when columns are missing', async () => {
    const el = await mount({ loopId: 'loop-1', columns: undefined, artifacts: [] })
    expect(el.innerHTML).toContain('needs columns=')
  })
})
