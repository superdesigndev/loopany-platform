// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, params, ...p }: { children?: unknown; to?: string; search?: { template?: string }; params?: { slug?: string }; [k: string]: unknown }) => {
    let href = typeof to === 'string' ? to : undefined
    if (href && params?.slug) href = href.replace('$slug', params.slug)
    if (href && search?.template) href = `${href}?template=${search.template}`
    return createElement('a', { href, ...p }, children as never)
  },
}))

import { TemplateDetail, type TemplateDetailData } from './TemplateDetail'
import type { TemplateInfo } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REAL_PROMPT = 'Set up a closed loop that stakes out one specific hard-to-reproduce bug. Verify a way to observe a recurrence...'

const template: TemplateInfo = {
  name: 'bug-vigil',
  label: 'Bug Vigil',
  desc: 'A closed loop that stakes out one specific hard-to-reproduce bug.',
  description: REAL_PROMPT,
  rating: {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'closed',
    visibility: 'compounds',
    visibilityNote: 'Waits out an intermittent bug; the capture can take weeks.',
    schedule: 'Patrol cadence (you set it)',
    does: 'Stakes out one elusive bug → captures full context',
    outcome: '🐛 Root cause, then it closes',
    exitCondition: 'Finishes on one clean capture of the bug.',
  },
}
const data: TemplateDetailData = { template, categoryLabel: 'Others', accent: 'secondary' }

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(d: TemplateDetailData | null): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TemplateDetail, { data: d }))
  })
  return host
}

describe('TemplateDetail', () => {
  it('exposes the loop: real prompt verbatim, mechanism facts, ratings, and a create deep link', async () => {
    const el = await mount(data)
    const out = el.innerHTML
    expect(out).toContain('Bug Vigil')
    expect(out).toContain('Others')
    // The REAL prompt is shown verbatim (not paraphrased) in the prompt block.
    expect(el.querySelector('pre')?.textContent).toBe(REAL_PROMPT)
    // A Copy button on the prompt block.
    expect([...el.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Copy prompt'))).toBe(true)
    // Structured mechanism facts, incl. the closed-loop exit condition + schedule.
    expect(out).toContain('Suggested schedule')
    expect(out).toContain('Patrol cadence (you set it)')
    expect(out).toContain('Exit condition')
    expect(out).toContain('Finishes on one clean capture of the bug.')
    expect(out).toContain('Closed loop')
    expect(out).toContain('Notifications')
    // The honest effect note is present.
    expect(out).toContain('Waits out an intermittent bug; the capture can take weeks.')
    // Primary CTA deep-links into the compose flow with this template preselected.
    const cta = [...el.querySelectorAll('a')].find((a) => (a.textContent ?? '').includes('Setup in Loopany'))
    expect(cta?.getAttribute('href')).toBe('/?template=bug-vigil')
  })

  it('shows an open loop as running indefinitely (no exit condition row value)', async () => {
    const openTmpl: TemplateInfo = {
      ...template,
      name: 'react-doctor',
      label: 'React Doctor',
      rating: { ...template.rating!, mechanism: 'open', exitCondition: undefined },
    }
    const el = await mount({ template: openTmpl, categoryLabel: 'Code Health', accent: 'interactive' })
    expect(el.innerHTML).toContain('Runs indefinitely (no finish line).')
    expect(el.innerHTML).toContain('Open loop')
  })

  it('renders a friendly not-found for an unknown slug', async () => {
    const el = await mount(null)
    expect(el.innerHTML).toContain('Template not found')
  })
})
