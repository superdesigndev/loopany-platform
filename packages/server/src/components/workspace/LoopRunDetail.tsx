import { useState } from 'react'

import { groupTranscript, summarizeTool } from '../../lib/transcript'
import { fetchLoopRun } from './api'
import { Markdown } from './Render'
import { affectsLoop, useLiveView } from './useLiveView'
import { DrawerHead, DrawerSection, Empty, Loading, Refusal, StateChip, When } from './parts'

const shortId = (id: string) => id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id

function duration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function SessionId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="ws-session-copy"
      title="Copy session id"
      onClick={() => {
        void navigator.clipboard?.writeText(id)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      <code>{id}</code>
      <span>{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

export function LoopRunDetail({ id, loopId }: { id: string; loopId: string }) {
  const { data, error } = useLiveView(`run:${id}`, () => fetchLoopRun(id), affectsLoop(loopId))
  if (error && !data) return <article className="preview-document"><Refusal error={error} /></article>
  if (!data) return <article className="preview-document"><Loading what="the run" /></article>
  const { run, loop } = data
  const trace = groupTranscript(run.transcript)
  const tokenIn = (run.usage?.inputTokens ?? 0) + (run.usage?.cacheReadTokens ?? 0) + (run.usage?.cacheCreationTokens ?? 0)
  const tokenOut = run.usage?.outputTokens ?? 0

  return (
    <article className="preview-document ws-run-detail">
      <DrawerHead
        kicker={`${run.role} run`}
        title={run.summary || `${loop.title ?? loop.id} run`}
        facets={
          <>
            <StateChip state={run.state} />
            {run.status && <span className="state-label">{run.status}</span>}
            <code className="ws-id" title={run.id}>{shortId(run.id)}</code>
          </>
        }
        meta={[
          ['loop', loop.title ?? loop.id],
          ['started', <When iso={run.startedAt} />],
          ['duration', duration(run.durationMs)],
          ['cost', run.costUsd == null ? '—' : `$${run.costUsd.toFixed(2)}`],
        ]}
      />

      {run.progress && (run.state === 'running' || run.state === 'queued') && (
        <div className="ws-live-activity" role="status">
          <span />
          <div><b>Step {run.progress.step}</b><p>{run.progress.label}</p></div>
        </div>
      )}

      <DrawerSection title="Final message">
        {run.summary ? <div className="ws-run-report">{run.summary}</div> : <Empty>No final message recorded.</Empty>}
        {run.error && <p className="inbox-floor">{run.error}</p>}
      </DrawerSection>

      <DrawerSection title="Metrics">
        {run.metrics && Object.keys(run.metrics).length ? (
          <dl className="ws-run-metrics">
            {Object.entries(run.metrics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
          </dl>
        ) : <Empty>No state metrics reported.</Empty>}
      </DrawerSection>

      <DrawerSection title="Execution trace">
        {trace.length ? (
          <ol className="ws-trace">
            {trace.map((item, index) => (
              <li key={index} className={`is-${item.kind}`}>
                <span className="ws-trace-marker">{item.kind === 'tool' ? '⚙' : '¶'}</span>
                <div>
                  {item.kind === 'tool' ? (
                    <>
                      <p className="ws-trace-title"><code>{item.name || 'tool'}</code>{summarizeTool(item.input) && <span>{summarizeTool(item.input)}</span>}</p>
                      {item.input && <details><summary>Input</summary><pre>{item.input}</pre></details>}
                    </>
                  ) : item.text ? <Markdown>{item.text}</Markdown> : null}
                  {item.results.map((result, resultIndex) => (
                    <details key={resultIndex} open={result.length < 240}><summary>Output</summary><pre>{result}</pre></details>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        ) : <Empty>No execution trace recorded for this run.</Empty>}
      </DrawerSection>

      <DrawerSection title="Artifacts">
        {run.artifacts?.length ? (
          <ul className="ws-run-artifacts">
            {run.artifacts.map((artifact) => <li key={`${artifact.kind}:${artifact.path}`}><span>{artifact.kind}</span><code>{artifact.path}</code></li>)}
          </ul>
        ) : <Empty>This run recorded no created or edited files.</Empty>}
      </DrawerSection>

      <DrawerSection title="Details">
        <dl className="ws-detail-list">
          <div><dt>Run id</dt><dd><code title={run.id}>{shortId(run.id)}</code></dd></div>
          <div><dt>Outcome</dt><dd>{run.outcome ?? '—'}</dd></div>
          <div><dt>Tokens</dt><dd>{run.usage ? `${tokenIn.toLocaleString()} in · ${tokenOut.toLocaleString()} out` : '—'}</dd></div>
          <div><dt>Turns</dt><dd>{run.usage?.numTurns ?? '—'}</dd></div>
          {run.sessionId && <div><dt>Session</dt><dd><SessionId id={run.sessionId} /></dd></div>}
        </dl>
      </DrawerSection>

      {run.control?.length ? (
        <DrawerSection title="Control actions">
          <ul className="ws-control-list">
            {run.control.map((action, index) => <li key={index}><code>{action.command}</code><span>{action.result}</span>{action.detail && <small>{action.detail}</small>}</li>)}
          </ul>
        </DrawerSection>
      ) : null}
    </article>
  )
}
