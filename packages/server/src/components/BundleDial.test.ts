// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BundleDial } from './BundleDial'
import type { BundleView, TemplateInfo } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tmpl = (name: string, label: string): TemplateInfo => ({
  name,
  label,
  desc: `${label} blurb`,
  description: `${label} full setup`,
})

const bundles: BundleView[] = [
  { name: 'engineering', label: 'Engineering', tagline: 'Keep your codebase healthy while you sleep.', accent: 'interactive', members: [tmpl('react-doctor', 'React Doctor'), tmpl('housekeeper', 'Tech Debt Cleanup')] },
  { name: 'growth', label: 'Growth', tagline: 'Watch your market and grow your audience.', accent: 'rubik-green', members: [tmpl('market-research', 'Market Monitor')] },
  { name: 'operations', label: 'Operations', tagline: 'Stay on top of customers and what you shipped.', accent: 'rubik-orange', members: [tmpl('support-triage', 'Support Triage')] },
]

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(props: Parameters<typeof BundleDial>[0]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(BundleDial, props))
  })
  return host
}

describe('BundleDial', () => {
  it('renders every bundle (all spokes) with its label + tagline', async () => {
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    const out = el.innerHTML
    for (const b of bundles) {
      expect(out).toContain(b.label)
      expect(out).toContain(b.tagline)
    }
    // The oversized disc is inside a clipped stage — the no-page-scroll guarantee.
    expect(el.querySelector('.dial-stage')).toBeTruthy()
    expect(el.querySelector('.dial-wheel')).toBeTruthy()
  })

  it('spins Engineering → Growth → Operations, updating the wheel rotation', async () => {
    const el = await mount({ bundles, onPickTemplate: vi.fn(), onTryBundle: vi.fn() })
    const wheel = el.querySelector('.dial-wheel') as HTMLElement
    // idx 0 → 0deg.
    expect(wheel.style.getPropertyValue('--rot')).toBe('0deg')
    const nextBtn = el.querySelector('.dial-arrow-next') as HTMLButtonElement
    const prevBtn = el.querySelector('.dial-arrow-prev') as HTMLButtonElement
    // At the start the prev arrow is disabled (no wrap-around).
    expect(prevBtn.disabled).toBe(true)
    await act(async () => nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(wheel.style.getPropertyValue('--rot')).toBe('-52deg')
    await act(async () => nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(wheel.style.getPropertyValue('--rot')).toBe('-104deg')
    // At the last bundle the next arrow is disabled.
    expect(nextBtn.disabled).toBe(true)
  })

  it('fires onTryBundle for the active bundle and onPickTemplate for a single card', async () => {
    const onTryBundle = vi.fn()
    const onPickTemplate = vi.fn()
    const el = await mount({ bundles, onPickTemplate, onTryBundle })
    // The active (Engineering) try button.
    const tryBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('try this bundle'))!
    await act(async () => tryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onTryBundle).toHaveBeenCalledWith(bundles[0])
    // An active member card → the single-template path.
    const card = [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('React Doctor'))!
    await act(async () => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onPickTemplate).toHaveBeenCalledWith(bundles[0]!.members[0])
  })
})
