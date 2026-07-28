// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TemplateFlowDiagram } from './TemplateFlowDiagram'
import { FLOWS, templateFlowDiagram } from '../lib/templateFlow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(name: string): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TemplateFlowDiagram, { name }))
  })
  return host
}

describe('templateFlowDiagram (derivation, pure)', () => {
  it('folds a spec into trigger -> steps -> outputs, splitting the one-time setup gate', () => {
    // error-sweep is the shape that exercises everything: a setup gate, a plain step
    // pair, a worktree step pair, and two dashboard surfaces.
    const f = templateFlowDiagram('error-sweep')!
    expect(f.setup?.kicker).toBe('Before first run')
    // The trigger is the cadence node, never the setup gate.
    expect(f.trigger.kicker).toBe('On schedule')
    expect(f.trigger.label).toContain('Every day')
    expect(f.steps.map((s) => s.label)).toEqual(['Group into incidents', 'Actionable vs. noise', 'Root-cause & fix', 'One PR per fix'])
    expect(f.steps.filter((s) => s.worktree).map((s) => s.label)).toEqual(['Root-cause & fix', 'One PR per fix'])
    // Outputs are the dashboard surfaces the loop maintains, typed by widget.
    expect(f.outputs).toEqual([
      { glyph: '▢', kicker: 'Report', label: 'Newest report' },
      { glyph: '◔', kicker: 'Metric', label: 'Actionable errors' },
    ])
    expect(f.closes).toBe(false)
  })

  it('reads the closed-loop terminus from the spec, not from a second list', () => {
    expect(templateFlowDiagram('follow-up-tracker')?.closes).toBe(true)
    expect(templateFlowDiagram('react-doctor')?.closes).toBe(false)
  })

  it('is null for a template with no spec — never an invented flow', () => {
    expect(templateFlowDiagram('morning-briefing')).toBeNull()
    expect(templateFlowDiagram('')).toBeNull()
  })

  it('derives cleanly for EVERY spec in the registry', () => {
    for (const name of Object.keys(FLOWS)) {
      const f = templateFlowDiagram(name)
      expect(f, `${name} should derive`).toBeTruthy()
      expect(f!.trigger.label, `${name} needs a trigger label`).toBeTruthy()
      expect(f!.steps.length, `${name} needs at least one step`).toBeGreaterThan(0)
      expect(f!.outputs.length, `${name} needs at least one output`).toBeGreaterThan(0)
      expect(f!.outputs.every((o) => !!o.label)).toBe(true)
    }
  })
})

describe('TemplateFlowDiagram (the drawn diagram)', () => {
  it('draws trigger, steps and outputs, with the worktree stretch boxed once', async () => {
    const el = await mount('error-sweep')
    const out = el.textContent ?? ''
    expect(out).toContain('How a run flows')
    expect(out).toContain('Before first run')
    expect(out).toContain('Every day · 6am')
    expect(out).toContain('Group into incidents')
    expect(out).toContain('Newest report')
    // ONE dashed isolation box around the consecutive worktree steps (not one each).
    const boxes = [...el.querySelectorAll('.border-dashed')].filter((b) => (b.textContent ?? '').includes('Isolated git worktree'))
    expect(boxes.length).toBe(1)
    expect(boxes[0]!.textContent).toContain('Root-cause & fix')
    expect(boxes[0]!.textContent).toContain('One PR per fix')
    // The pre-worktree steps stay outside it.
    expect(boxes[0]!.textContent).not.toContain('Group into incidents')
    // Solid connector edges between the three columns.
    expect(el.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
  })

  it('names the loop mechanism honestly at the end of the flow', async () => {
    expect((await mount('react-doctor')).textContent).toContain('open loop — repeats on the next tick')
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = null
    expect((await mount('follow-up-tracker')).textContent).toContain('closed loop — it finishes itself')
  })

  it('renders NOTHING for a template with no flow spec', async () => {
    const el = await mount('morning-briefing')
    expect(el.innerHTML).toBe('')
  })
})

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('wiring: SSR-safe + single-sourced', () => {
  it('the diagram is static — no hooks, effects, timers or graph lib', () => {
    // The public detail route SSRs on purpose; anything client-only would render an
    // empty box in the server HTML crawlers and unfurlers read.
    const s = src('./TemplateFlowDiagram.tsx')
    expect(s).not.toMatch(/\buseState|useEffect|useLayoutEffect|useRef\b/)
    expect(s).not.toMatch(/requestAnimationFrame|setTimeout|setInterval/)
    expect(s).not.toMatch(/getBoundingClientRect|ResizeObserver|window\./)
    expect(s).not.toMatch(/from 'recharts'|d3|reactflow/)
  })

  it('the detail page renders it, and BOTH flow surfaces read the same spec module', () => {
    expect(src('./TemplateDetail.tsx')).toContain('<TemplateFlowDiagram name={t.name} />')
    // One spec source: the modal's animated preview and this static diagram both import
    // lib/templateFlow, so a template can never describe two different flows.
    expect(src('./LoopFlow.tsx')).toContain("from '../lib/templateFlow'")
    expect(src('./TemplateFlowDiagram.tsx')).toContain("from '../lib/templateFlow'")
    expect(src('./LoopFlow.tsx')).not.toMatch(/^const FLOWS/m)
  })
})
