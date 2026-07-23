// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BundleShelf, splitRows } from './BundleShelf'
import type { BundleView, TemplateInfo } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tmpl = (name: string, label: string): TemplateInfo => ({
  name,
  label,
  desc: `${label} blurb`,
  description: `${label} full setup`,
})

const bundle = (name: string, label: string, accent: BundleView['accent'], members: [string, string][]): BundleView => ({
  name,
  label,
  tagline: `${label} tagline`,
  accent,
  members: members.map(([n, l]) => tmpl(n, l)),
})

const three: BundleView[] = [
  bundle('engineering', 'Engineering', 'interactive', [['react-doctor', 'React Doctor'], ['housekeeper', 'Tech Debt Cleanup'], ['docs-sweep', 'Doc Maintainer'], ['dependency-triage', 'Dependency Triage'], ['error-sweep', 'Error Sweep']]),
  bundle('growth', 'Growth', 'rubik-green', [['market-research', 'Market Monitor'], ['reddit-karma', 'Reddit Karma']]),
  bundle('operations', 'Operations', 'rubik-orange', [['support-triage', 'Support Triage'], ['follow-up-tracker', 'Follow-up Tracker']]),
]

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(props: Parameters<typeof BundleShelf>[0]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(BundleShelf, props))
  })
  return host
}

describe('splitRows — balanced rows of up to N, larger row on top', () => {
  const sizes = (rows: number[][]) => rows.map((r) => r.length)
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('keeps <=3 in a single row', () => {
    expect(sizes(splitRows(seq(3), 3))).toEqual([3])
    expect(sizes(splitRows(seq(2), 3))).toEqual([2])
    expect(sizes(splitRows(seq(1), 3))).toEqual([1])
  })

  it('splits 5 into 3 on top, 2 below (the captain example)', () => {
    expect(sizes(splitRows(seq(5), 3))).toEqual([3, 2])
  })

  it('generalizes: 4->[2,2], 6->[3,3], 7->[3,2,2], 9->[3,3,3]', () => {
    expect(sizes(splitRows(seq(4), 3))).toEqual([2, 2])
    expect(sizes(splitRows(seq(6), 3))).toEqual([3, 3])
    expect(sizes(splitRows(seq(7), 3))).toEqual([3, 2, 2])
    expect(sizes(splitRows(seq(9), 3))).toEqual([3, 3, 3])
  })

  it('never drops an item and never exceeds the max per row', () => {
    for (let n = 1; n <= 12; n++) {
      const rows = splitRows(seq(n), 3)
      expect(rows.flat().length).toBe(n)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(3)
      // rows are non-increasing (larger row on top).
      const s = rows.map((r) => r.length)
      for (let i = 1; i < s.length; i++) expect(s[i]!).toBeLessThanOrEqual(s[i - 1]!)
    }
  })
})

describe('BundleShelf', () => {
  it('shows EVERY bundle at once with its name, tagline, and loop count', async () => {
    const el = await mount({ bundles: three, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    const out = el.innerHTML
    for (const b of three) {
      expect(out).toContain(b.label)
      expect(out).toContain(b.tagline)
    }
    // Loop counts are shown per bundle (Engineering has 5, Growth/Operations 2 each).
    expect(out).toContain('5 loops')
    expect(out).toContain('2 loops')
    // One try-CTA per bundle (no carousel, no arrows/dots).
    const ctas = [...el.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('try this bundle'))
    expect(ctas.length).toBe(three.length)
  })

  it('renders a simulated 5-bundle set in two rows (3 + 2)', async () => {
    const five: BundleView[] = [
      ...three,
      bundle('extra-a', 'Extra A', 'interactive', [['x1', 'Loop X1']]),
      bundle('extra-b', 'Extra B', 'rubik-green', [['x2', 'Loop X2']]),
    ]
    const el = await mount({ bundles: five, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    // Two row containers, sized 3 then 2 (each row holds N cluster columns).
    const rows = [...el.querySelectorAll('.flex.flex-wrap')]
    expect(rows.length).toBe(2)
    const clustersIn = (row: Element) => [...row.children].length
    expect(clustersIn(rows[0]!)).toBe(3)
    expect(clustersIn(rows[1]!)).toBe(2)
  })

  it('fires onTryBundle for that bundle and onPickTemplate for a single card', async () => {
    const onTryBundle = vi.fn()
    const onPickTemplate = vi.fn()
    const el = await mount({ bundles: three, onPickTemplate, onTryBundle })
    // Growth's try button → onTryBundle(growth).
    const growthCta = [...el.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('try this bundle'))[1]!
    await act(async () => growthCta.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onTryBundle).toHaveBeenCalledWith(three[1])
    // A single member card → the single-template path.
    const card = [...el.querySelectorAll('button.fan-card')].find((b) => (b.textContent ?? '').includes('React Doctor'))!
    await act(async () => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onPickTemplate).toHaveBeenCalledWith(three[0]!.members[0])
  })
})
