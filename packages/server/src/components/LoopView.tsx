import { useEffect, useMemo, useState } from 'react'
import DOMPurify, { type Config } from 'dompurify'
import parse, { Element, type HTMLReactParserOptions } from 'html-react-parser'
import type { ArtifactSummary, RunSummary } from '../types'
import { buildBindingContext, parseSeries, resolveBindings } from '../lib/binding'
import { numericSeries } from '../lib/stats'
import { getArtifacts } from '../server/loopApi'
import { LoopChart } from './LoopChart'
import { LoopSparkline } from './LoopSparkline'
import { LoopEmbed } from './LoopEmbed'
import { LoopCalendar } from './LoopCalendar'

/**
 * Renders a loop's generative-UI template (agent-authored HTML on `Job.ui`).
 *
 * Pipeline: interpolate `{{ ... }}` scalar bindings with live run data → DOMPurify
 * sanitize (allowlisted HTML subset; NO script/handlers/raw-svg) → parse to React,
 * swapping the irreducible data primitives for their renderers. Everything
 * else (A/B panels, stat tiles, layout, text) is the agent's own HTML — there are
 * NO opinionated panel components.
 *
 *   <loop-chart series="mrr:MRR:$, paid:Paid"></loop-chart>   multi-series trend chart
 *   <loop-sparkline key="mrr"></loop-sparkline>                inline sparkline
 *   <loop-embed match="reports/digest-*.md"></loop-embed>      newest matching artifact, embedded
 *   <loop-calendar match="reports/*.md"></loop-calendar>       month calendar of produced files
 *
 * Registering a new primitive means moving three things together: LOOP_TAGS +
 * the sanitizer config below, the parser swap in `options`, and the skill's
 * authoring docs (references/evolve.md §3, run/edit.md) - the sanitizer
 * allowlist and the skill prose must never drift apart.
 */

const LOOP_TAGS = ['loop-chart', 'loop-sparkline', 'loop-embed', 'loop-calendar']

/** Data-bearing attributes on the loop-* primitives (all parsed by us, never markup). */
const LOOP_ATTRS = ['series', 'key', 'file', 'match', 'full']

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'p', 'b', 'strong', 'i', 'em', 'u', 's', 'span', 'div',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'code', 'pre', 'br',
    'hr', 'small', 'section', 'header', 'footer', 'a', 'figure', 'figcaption', 'mark',
    ...LOOP_TAGS,
  ],
  ALLOWED_ATTR: ['style', 'class', 'href', 'title', 'target', 'rel', ...LOOP_ATTRS],
  ADD_TAGS: LOOP_TAGS,
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: /^loop-(chart|sparkline|embed|calendar)$/,
    attributeNameCheck: /^(series|key|file|match|full)$/,
    allowCustomizedBuiltInElements: false,
  },
}

// `series="cpu:CPU:℃, inlet:进风口:℃"` and `match="reports/digest-*.md"` carry
// colons/commas/globs/unicode that DOMPurify otherwise strips from the attribute
// value (leaving an empty <loop-*> that renders nothing). These attrs hold only
// data we parse ourselves — no markup — so force-keep them on loop-* elements.
// Registered once at module load.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  const tag = node.nodeName?.toLowerCase()
  if (tag && LOOP_TAGS.includes(tag) && LOOP_ATTRS.includes(data.attrName)) {
    data.forceKeepAttr = true
  }
})

export function LoopView({
  html,
  runs,
  loopId,
  taskFile,
}: {
  html: string
  runs: RunSummary[]
  loopId: string
  /** The loop's task-file path - lets <loop-calendar> exclude the spec from its default product set. */
  taskFile?: string
}) {
  const clean = useMemo(() => {
    const ctx = buildBindingContext(runs)
    return DOMPurify.sanitize(resolveBindings(html, ctx), SANITIZE_CONFIG)
  }, [html, runs])

  // One numeric-series pass shared by every loop-chart/loop-sparkline in the template.
  const data = useMemo(() => numericSeries(runs), [runs])

  // The artifact-backed primitives share ONE lazy artifact-list fetch - made
  // only when the template actually uses them, so a chart-only dashboard pays
  // nothing. Refreshed when the newest run changes (new run ⇒ likely new files).
  const wantsArtifacts = /<loop-(embed|calendar)\b/.test(html)
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const newestRunId = runs[0]?.id
  useEffect(() => {
    if (!wantsArtifacts) return
    let alive = true
    getArtifacts({ data: { loopId } })
      .then((list) => alive && setArtifacts(list))
      .catch(() => alive && setArtifacts((prev) => prev ?? []))
    return () => {
      alive = false
    }
  }, [wantsArtifacts, loopId, newestRunId])

  const options: HTMLReactParserOptions = useMemo(
    () => ({
      replace: (node) => {
        if (!(node instanceof Element)) return undefined
        const a = node.attribs ?? {}
        if (node.name === 'loop-chart') return <LoopChart data={data} series={parseSeries(a.series)} />
        if (node.name === 'loop-sparkline') return <LoopSparkline series={data} field={a.key} />
        if (node.name === 'loop-embed')
          return (
            <LoopEmbed loopId={loopId} artifacts={artifacts} file={a.file} match={a.match} full={'full' in a} />
          )
        if (node.name === 'loop-calendar')
          return <LoopCalendar loopId={loopId} artifacts={artifacts} match={a.match} taskFile={taskFile} />
        return undefined
      },
    }),
    [data, loopId, taskFile, artifacts],
  )

  return <div className="loopview space-y-2 text-[14px] leading-relaxed">{parse(clean, options)}</div>
}
