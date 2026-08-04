import { useState } from 'react'

import { fetchInbox, postVerdict, ViewError, type InboxItem } from './api'
import { ExecutionBlock, Markdown } from './Render'
import {
  ArtifactRow, BigState, CountStrip, Empty, Glyph, Loading, reasonLabel, reasonTone, Refusal, Section, Timeline, ViewHeader, When,
} from './parts'
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
 * The whole union lives inside ONE amber section card, because the reference's
 * temperature rule says what amber means: a queue of ordinary decisions, and
 * looking at it should feel like work rather than alarm. The per-item pill then
 * says WHICH route brought it here — a question keeps the amber (a decision you
 * owe), while the two safety-floor routes take the rose, since both are work
 * nobody picked up rather than a decision anyone made.
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

  if (error && !data) {
    return (
      <BigState title="The inbox is not answering">
        {error.message} The view endpoints are human-only — a signed-in session is what they gate on.
      </BigState>
    )
  }
  if (!data) return <Loading what="the inbox" />

  return (
    <div className="document-view">
      <ViewHeader
        eyebrow="Inbox"
        title="Inbox"
        description="Everything waiting on a person. The system's default mode is zero human involvement — you are invited in by exception."
        meta={data.counts.total === 0 ? 'nothing waiting' : `${data.counts.total} waiting`}
      />
      <CountStrip counts={data.counts} />

      {error && data && <Refusal error={error} />}

      {data.items.length === 0 ? (
        <Section tone="plain" title="Needs you" count={0} note="Open obligations">
          <Empty>Nothing is waiting on you. Loops are running; tasks are being adopted, verified and closed without you.</Empty>
        </Section>
      ) : (
        <Section tone="needs" title="Needs you" count={data.items.length} note="Questions, due-unwatched work and the orphan floor">
          <ul className="inbox-list">
            {data.items.map((item) => (
              <InboxItemRow key={item.task.id} item={item} onAnswered={refresh} onOpenTask={onOpenTask} onOpenLoop={onOpenLoop} />
            ))}
          </ul>
        </Section>
      )}

      {loading && <p className="ws-refreshing">refreshing…</p>}
    </div>
  )
}

function InboxItemRow({
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
  const primary = item.reasons[0] ?? 'orphan'

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
    <li className="inbox-item">
      <ArtifactRow
        icon={asking ? 'question' : 'orphan'}
        iconTone={asking ? 'question' : 'orphan'}
        title={item.task.title ?? item.task.id}
        source={
          <>
            {item.creator ? (item.creator.title ?? item.creator.id) : 'you'}
            {item.askedByRun ? ` · ${item.askedByRun}` : ''}
          </>
        }
        state={reasonLabel(primary)}
        stateTone={reasonTone(primary)}
        when={item.askedAt ?? item.task.followUpAt ?? item.task.updatedAt}
        action={<span className="artifact-action">open ›</span>}
        onOpen={() => onOpenTask(item.task.id)}
        ariaLabel={`Open ${item.task.title ?? item.task.id}`}
      />

      <div className="inbox-body">
        {item.reasons.length > 1 && (
          <p className="inbox-meta">
            <span>also: {item.reasons.slice(1).map(reasonLabel).join(' · ')}</span>
          </p>
        )}

        {asking ? (
          <p className="inbox-question">
            <Glyph name="question" />
            {item.task.pendingQuestion}
          </p>
        ) : (
          <p className="inbox-floor">
            No question here. This task reached you through the safety floor: nobody is watching it, so it would otherwise sit unseen.
          </p>
        )}

        <p className="inbox-meta">
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
          {item.task.followUpAt && <When iso={item.task.followUpAt} prefix="follow-up" />}
        </p>

        {item.task.body.trim() && <Markdown>{item.task.body}</Markdown>}

        {/* The contract: the payload, verbatim, next to the box you answer in. */}
        <ExecutionBlock payload={item.execution} />

        {asking ? (
          <form
            className="answer-box"
            onSubmit={(event) => {
              event.preventDefault()
              void send(answer)
            }}
          >
            <label htmlFor={`answer-${item.task.id}`}>Your answer</label>
            <textarea
              id={`answer-${item.task.id}`}
              className="field-text"
              value={answer}
              rows={3}
              placeholder="Free text. A reason is what lets the loop converge next time."
              onChange={(event) => setAnswer(event.target.value)}
            />
            <div className="answer-actions">
              <button type="button" className="verdict-button" disabled={busy} onClick={() => void send(answer.trim() || 'approve')}>
                Approve
              </button>
              <button
                type="button"
                className="attn-button"
                disabled={busy}
                onClick={() => void send(answer.trim() ? `reject: ${answer.trim()}` : 'reject')}
              >
                Reject
              </button>
              <button type="submit" className="solid-button" disabled={busy || !answer.trim()}>
                {busy ? 'Sending…' : 'Send answer'}
              </button>
            </div>
            <p className="answer-note">
              Approve and Reject send exactly what is in the box — the platform never parses your words, only agents interpret them.
            </p>
          </form>
        ) : null}

        {queued && <p className="inbox-queued">answer recorded · {queued}</p>}
        {failure && <Refusal error={failure} />}

        <details className="inbox-events">
          <summary>Recent events</summary>
          <Timeline events={item.recentEvents} />
        </details>
      </div>
    </li>
  )
}
