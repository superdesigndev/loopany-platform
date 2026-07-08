import { useEffect, useMemo, useState } from 'react'
import DOMPurify, { type Config } from 'dompurify'
import parse, { Element, type HTMLReactParserOptions } from 'html-react-parser'
import type { ArtifactSummary, RunSummary } from '../types'
import { buildBindingContext, parseSeries, resolveBindings } from '../lib/binding'
import { numericSeries } from '../lib/stats'
import { getArtifacts } from '../server/loopApi'
import { LoopChart } from './LoopChart'
import { LoopEmbed } from './LoopEmbed'
import { LoopCalendar } from './LoopCalendar'
import { LoopKanban } from './LoopKanban'

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
 *   <loop-embed match="reports/digest-*.md"></loop-embed>      newest matching artifact, embedded
 *   <loop-calendar match="reports/*.md"></loop-calendar>       month calendar of produced files
 *   <loop-kanban columns="a,b,c" match="notes/*.md">           typed products as a board, columns = type
 *
 * Registering a new primitive means moving three things together: LOOP_TAGS +
 * the sanitizer config below, the parser swap in `options`, and the skill's
 * authoring docs (references/evolve.md §3, run/edit.md) - the sanitizer
 * allowlist and the skill prose must never drift apart.
 */

const LOOP_TAGS = ['loop-chart', 'loop-embed', 'loop-calendar', 'loop-kanban']

/** Data-bearing attributes on the loop-* primitives (all parsed by us, never markup). */
const LOOP_ATTRS = ['series', 'file', 'match', 'full', 'columns']

const ARTIFACT_RETRY_MAX = 3
const ARTIFACT_RETRY_MS = 4000

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
    tagNameCheck: new RegExp(`^(?:${LOOP_TAGS.join('|')})$`),
    attributeNameCheck: new RegExp(`^(?:${LOOP_ATTRS.join('|')})$`),
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
  /** The loop's task-file path - lets <loop-embed>/<loop-calendar>/<loop-kanban> exclude the spec from match results / the default product set. */
  taskFile?: string
}) {
  const clean = useMemo(() => {
    const ctx = buildBindingContext(runs)
    return DOMPurify.sanitize(resolveBindings(html, ctx), SANITIZE_CONFIG)
  }, [html, runs])

  // One numeric-series pass shared by every loop-chart in the template.
  const data = useMemo(() => numericSeries(runs), [runs])

  // The artifact-backed primitives share ONE lazy artifact-list fetch - made
  // only when the template actually uses them, so a chart-only dashboard pays
  // nothing. Refreshed when the newest run changes (new run ⇒ likely new files)
  // AND when that run settles (its final sync is what lands the new files -
  // keying on the id alone would show run N's output only once run N+1 starts).
  // Detected on the SANITIZED html: DOMPurify lowercases tag names, so this
  // also catches uppercase-authored tags and tags materialized by bindings.
  // A failed fetch keeps the current state (null ⇒ still loading) and retries
  // a bounded few times - the deps don't move between runs, so latching an
  // empty list here would show "no file matches" until the next run settles.
  const wantsArtifacts = /<loop-(embed|calendar|kanban)\b/.test(clean)
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const newestRunId = runs[0]?.id
  const newestRunLive = runs[0]?.running === true
  useEffect(() => {
    if (!wantsArtifacts) return
    let alive = true
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      getArtifacts({ data: { loopId } })
        .then((list) => alive && setArtifacts(list))
        .catch(() => {
          if (alive && retries < ARTIFACT_RETRY_MAX) timer = setTimeout(load, ARTIFACT_RETRY_MS * ++retries)
        })
    }
    load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [wantsArtifacts, loopId, newestRunId, newestRunLive])

  const options: HTMLReactParserOptions = useMemo(
    () => ({
      replace: (node) => {
        if (!(node instanceof Element)) return undefined
        const a = node.attribs ?? {}
        if (node.name === 'loop-chart') return <LoopChart data={data} series={parseSeries(a.series)} />
        if (node.name === 'loop-embed')
          return (
            <LoopEmbed
              loopId={loopId}
              artifacts={artifacts}
              file={a.file}
              match={a.match}
              full={'full' in a}
              taskFile={taskFile}
            />
          )
        if (node.name === 'loop-calendar')
          return <LoopCalendar loopId={loopId} artifacts={artifacts} match={a.match} taskFile={taskFile} />
        if (node.name === 'loop-kanban')
          return (
            <LoopKanban
              loopId={loopId}
              artifacts={artifacts}
              columns={a.columns}
              match={a.match}
              taskFile={taskFile}
            />
          )
        return undefined
      },
    }),
    [data, loopId, taskFile, artifacts],
  )

  // `.loopview` is a responsive grid (app.css): independent top-level panels sit
  // side by side on desktop (e.g. calendar left, document right) and stack on
  // narrow viewports; headings/prose span the full width so only panels tile.
  return <div className="loopview text-[14px] leading-relaxed">{parse(clean, options)}</div>
}
