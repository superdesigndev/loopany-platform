import { useState } from 'react'

import { fetchInbox, postVerdict, ViewError, type InboxItem } from './api'
import { ExecutionBlock, Markdown } from './Render'
import { Empty, Loading, ReasonChips, Refusal, Timeline, When } from './parts'
import { affectsTasks, useLiveView } from './useLiveView'

/**
 * THE INBOX — the product's front door, and the only screen a human is required
 * to visit.
 *
 * It shows the §6 union: questions waiting, due tasks nobody is watching, and
 * the orphan floor (open + unwatched + no follow-up + older than 48 h). All
 * three are QUERIES, not pushes — the badge is a query result, so nothing can
 * lie down silently forever and nothing needs an armed alarm to resurface.
 *
 * Answering is deliberately plain. **The verdict is pure**: it records the
 * answer, clears the question, writes the event, and — if the task has a watcher
 * — queues one express run. It executes nothing, parses nothing, joins nothing.
 * Approve, reject and instructions are all just the answer; the buttons here
 * only PREFILL the box, they are not a second, structured API, and the reason a
 * person types is what lets the loop converge next time.
 */
export function InboxPane({ onOpenTask, onOpenLoop }: { onOpenTask: (id: string) => void; onOpenLoop: (id: string) => void }) {
  const { data, error, loading, refresh } = useLiveView('inbox', fetchInbox, affectsTasks)

  if (error && !data) return <Refusal error={error} />
  if (!data) return <Loading what="the inbox" />

  return (
    <div className="ws-pane">
      <header className="ws-pane-head">
        <div>
          <h1>Inbox</h1>
          <p>Everything waiting on a person. The system's default mode is zero human involvement — you are invited in by exception.</p>
        </div>
        <dl className="ws-counts">
          <div>
            <dt>questions</dt>
            <dd>{data.counts.question}</dd>
          </div>
          <div>
            <dt>due · unwatched</dt>
            <dd>{data.counts.dueUnwatched}</dd>
          </div>
          <div>
            <dt>orphan floor</dt>
            <dd>{data.counts.orphan}</dd>
          </div>
        </dl>
      </header>

      {loading && <p className="ws-refreshing">refreshing…</p>}
      {error && data && <Refusal error={error} />}

      {data.items.length === 0 ? (
        <Empty>Nothing is waiting on you. Loops are running; tasks are being adopted, verified and closed without you.</Empty>
      ) : (
        <ul className="ws-inbox-list">
          {data.items.map((item) => (
            <InboxCard key={item.task.id} item={item} onAnswered={refresh} onOpenTask={onOpenTask} onOpenLoop={onOpenLoop} />
          ))}
        </ul>
      )}
    </div>
  )
}

function InboxCard({
  item,
  onAnswered,
  onOpenTask,
  onOpenLoop,
}: {
  item: InboxItem
  onAnswered: () => void
  onOpenTask: (id: string) => void
  onOpenLoop: (id: string) => void
}) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const [queued, setQueued] = useState<string | undefined>(undefined)
  const asking = Boolean(item.task.pendingQuestion?.trim())

  const send = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await postVerdict(item.task.id, text.trim())
      // R-answer: the answer wakes the watcher. It JOINS an already-queued run
      // rather than stacking a twin, so say which happened.
      setQueued(result.run ? (result.run.alreadyQueued ? `joined the run already queued (${result.run.id})` : `queued ${result.run.id}`) : 'no watcher — the answer sits on the record')
      setAnswer('')
      onAnswered()
    } catch (cause) {
      setFailure(cause instanceof ViewError ? cause : new Error(String(cause)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`ws-card ${asking ? 'is-question' : ''}`}>
      <header className="ws-card-head">
        <button type="button" className="ws-card-title" onClick={() => onOpenTask(item.task.id)}>
          {item.task.title ?? item.task.id}
        </button>
        <ReasonChips reasons={item.reasons} />
      </header>

      <div className="ws-card-meta">
        <span>
          from{' '}
          {item.creator ? (
            <button type="button" className="ws-link" onClick={() => onOpenLoop(item.creator!.id)}>
              {item.creator.title ?? item.creator.id}
            </button>
          ) : (
            'you'
          )}
        </span>
        <span>
          next{' '}
          {item.watcherLoop ? (
            <button type="button" className="ws-link" onClick={() => onOpenLoop(item.watcherLoop!.id)}>
              {item.watcherLoop.title ?? item.watcherLoop.id}
            </button>
          ) : (
            'unclaimed pool'
          )}
        </span>
        {item.askedAt && <When iso={item.askedAt} prefix="asked" />}
        {item.askedByRun && <code className="ws-id">{item.askedByRun}</code>}
        {item.task.followUpAt && <When iso={item.task.followUpAt} prefix="follow-up" />}
      </div>

      {asking && (
        <p className="ws-question">
          <Glyph />
          {item.task.pendingQuestion}
        </p>
      )}

      {item.task.body.trim() && (
        <div className="ws-card-body">
          <Markdown>{item.task.body}</Markdown>
        </div>
      )}

      {/* The contract: the payload, verbatim, next to the box you answer in. */}
      <ExecutionBlock payload={item.execution} />

      {asking ? (
        <form
          className="ws-answer"
          onSubmit={(event) => {
            event.preventDefault()
            void send(answer)
          }}
        >
          <label htmlFor={`answer-${item.task.id}`}>Your answer</label>
          <textarea
            id={`answer-${item.task.id}`}
            value={answer}
            rows={3}
            placeholder="Free text. A reason is what lets the loop converge next time."
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="ws-answer-actions">
            <button type="button" className="ws-approve" disabled={busy} onClick={() => void send(answer.trim() || 'approve')}>
              Approve
            </button>
            <button
              type="button"
              className="ws-reject"
              disabled={busy}
              onClick={() => void send(answer.trim() ? `reject: ${answer.trim()}` : 'reject')}
            >
              Reject
            </button>
            <button type="submit" className="ws-send" disabled={busy || !answer.trim()}>
              Send answer
            </button>
          </div>
          <small className="ws-answer-note">
            Approve and Reject send exactly what is in the box — the platform never parses your words, only agents interpret them.
          </small>
        </form>
      ) : (
        <p className="ws-answer-note">
          No question here. This task reached you through the safety floor: nobody is watching it, so it would otherwise sit unseen.
        </p>
      )}

      {queued && <p className="ws-queued">answer recorded · {queued}</p>}
      {failure && <Refusal error={failure} />}

      <details className="ws-card-events">
        <summary>Recent events</summary>
        <Timeline events={item.recentEvents} />
      </details>
    </li>
  )
}

function Glyph() {
  return (
    <span className="glyph" aria-hidden="true">
      ?
    </span>
  )
}
