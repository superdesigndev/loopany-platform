import { useMemo } from 'react'
import parse, { domToReact, Element, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser'
import type { RunSummary } from '../types'
import { parseSeries } from '../lib/binding'
import { sanitizeLoopUi } from '../lib/loopUi'
import { numericSeries } from '../lib/stats'
import { LoopChart } from './LoopChart'
import { LoopTabs } from './LoopTabs'

/**
 * Renders a loop's generative-UI template (agent-authored HTML on `Job.ui`).
 *
 * Pipeline: interpolate `{{ ... }}` scalar bindings with live run data → DOMPurify
 * sanitize (allowlisted HTML subset; NO script/handlers/raw-svg) → parse to React,
 * swapping the metric/layout primitives for their renderers. Everything
 * else (A/B panels, stat tiles, layout, text) is the agent's own HTML — there are
 * NO opinionated panel components.
 *
 *   <loop-chart series="mrr:MRR:$, paid:Paid"></loop-chart>   multi-series trend chart
 *   <loop-tabs tabs="A,B,C"><section>…</section>…</loop-tabs>  tab strip; one label per top-level <section>
 *
 * Registering a new primitive means moving three things together: LOOP_TAGS +
 * the sanitizer config below, the parser swap in `options`, and the skill's
 * authoring docs (references/evolve.md §3, run/edit.md) - the sanitizer
 * allowlist and the skill prose must never drift apart.
 */

export function LoopView({
  html,
  runs,
}: {
  html: string
  runs: RunSummary[]
  loopId: string
  taskFile?: string
}) {
  const clean = useMemo(() => sanitizeLoopUi(html, runs), [html, runs])

  // One numeric-series pass shared by every loop-chart in the template.
  const data = useMemo(() => numericSeries(runs), [runs])

  const options: HTMLReactParserOptions = useMemo(
    () => ({
      replace: (node) => {
        if (!(node instanceof Element)) return undefined
        const a = node.attribs ?? {}
        if (node.name === 'loop-chart') return <LoopChart data={data} series={parseSeries(a.series)} />
        if (node.name === 'loop-tabs') {
          const labels = (a.tabs ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          // One panel per top-level <section> child, parsed through the same
          // options so nested loop-* primitives keep working inside a tab. The
          // self-reference is safe: `replace` only runs once `parse` is called
          // below, long after the useMemo has assigned `options`.
          const panels = node.children
            .filter((c): c is Element => c instanceof Element && c.name === 'section')
            .map((sec) => domToReact(sec.children as DOMNode[], options))
          return <LoopTabs labels={labels} panels={panels} />
        }
        return undefined
      },
    }),
    [data],
  )

  // `.loopview` is a responsive grid (app.css): independent top-level panels sit
  // side by side on desktop (e.g. calendar left, document right) and stack on
  // narrow viewports; headings/prose span the full width so only panels tile.
  return <div className="loopview text-[14px] leading-relaxed">{parse(clean, options)}</div>
}
