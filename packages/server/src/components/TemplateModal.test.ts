// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TemplateModal } from './TemplateModal'
import type { TemplateInfo } from '../types'

// The connect-key machinery the modal reuses. mintClaim resolves a token so the
// snippet renders; claimStatus never completes (we assert the pre-create surface).
vi.mock('../server/loopApi', () => ({
  mintClaim: vi.fn(async () => ({ token: 'dk_test123' })),
  getConfig: vi.fn(async () => ({ loopanyCli: 'npx @crewlet/loopany@latest', customCli: false })),
  claimStatus: vi.fn(async () => ({ done: false })),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TEMPLATES: TemplateInfo[] = [
  {
    name: 'react-doctor',
    label: 'React Doctor',
    desc: 'A daily guardian for a React app.',
    tags: ['React', 'Daily'],
    slots: [{ name: 'run-at', prompt: 'Run each day at', kind: 'cron', required: false, default: '05:00' }],
  },
]

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
  document.body.innerHTML = ''
})

async function mount(props: Parameters<typeof TemplateModal>[0]): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TemplateModal, props))
  })
  // Flush the mint-claim / config promises the snippet step kicks off.
  await act(async () => {})
}

// The Base UI Dialog portals its content onto document.body.
const doc = () => document.body.innerHTML

function clickButton(title: string): Promise<void> {
  const btn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(title))
  if (!btn) throw new Error(`no button "${title}"`)
  return act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const base = { templates: TEMPLATES, onClose: () => {}, onCreated: () => {} }

describe('TemplateModal', () => {
  it('renders template cards with label, desc, and tags on the select step', async () => {
    await mount({ ...base, open: true })
    const out = doc()
    expect(out).toContain('React Doctor')
    expect(out).toContain('A daily guardian for a React app.')
    expect(out).toContain('React')
    expect(out).toContain('Daily')
  })

  it('picking a card opens the optional-slot panel with the defaulted schedule', async () => {
    await mount({ ...base, open: true })
    await clickButton('React Doctor')
    const timeInput = document.body.querySelector('input[type="time"]') as HTMLInputElement | null
    expect(timeInput).toBeTruthy()
    expect(timeInput?.value).toBe('05:00')
  })

  it('continues to the snippet: mints a connect-key and shows the copyable one-liner + slot line', async () => {
    await mount({ ...base, open: true })
    await clickButton('React Doctor')
    await clickButton('Continue')
    await act(async () => {}) // flush mintClaim/getConfig
    const out = doc()
    // The template one-liner points at the per-template serving endpoint.
    expect(out).toContain('/api/template/react-doctor and help me set it up')
    // The minted connect-key + server-url config lines.
    expect(out).toContain('connect-key: dk_test123')
    expect(out).toContain('server-url:')
    // The chosen slot value rides along as a plain line.
    expect(out).toContain('run-at: 05:00')
  })

  it('renders an empty-state when no templates are available', async () => {
    await mount({ ...base, open: true, templates: [] })
    expect(doc()).toContain('No templates available yet.')
  })
})
