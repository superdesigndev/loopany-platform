import { useState } from 'react'

import { fetchInbox, postVerdict, ViewError, type InboxItem } from './api'
import { isDeletedLoop, loopLabel } from './loopLabel'
import { ExecutionBlock, Markdown } from './Render'
import {
  ArtifactRow, BigState, Empty, Glyph, Loading, reasonLabel, reasonTone, Refusal, Section, Timeline, ViewHeader, When,
} from './parts'
import { affectsTasks, useLiveView } from './useLiveView'

/**
 * THE INBOX — the product's front door, and the only screen a human is required
 * to visit.
 *
 * It shows the §6 floor: open tasks with a question waiting for a person. That
 * is a QUERY, not a push — the badge is a query result, so nothing can lie down
 * silently forever and nothing needs an armed alarm to resurface.
 *
 * It used to show three routes. The other two — a due task nobody watched, and
 * the 48-hour orphan floor — both existed to catch work with no loop on the
 * hook, and the watcher rule (`kernel/types.ts` WATCHER_HINT) means there is no
 * such work: every task names a watcher, and a due one now WAKES that watcher
 * (`tickDueTasks`) instead of being escalated to a person. The inbox got
 * smaller because the system got safer, not because a floor was lowered.
 *
 * The floor lives inside ONE amber section card, because the reference's
 * temperature rule says what amber means: a queue of ordinary decisions, and
 * looking at it should feel like work rather than alarm.
 *
 * ONE COUNT PER FACT (captain direction, 2026-08-05). "How many questions are
 * waiting" used to be stated three times on this page — the header meta, a
 * full-width stat block under it, and the section heading — plus a fourth time
 * in the rail. The header keeps it; the stat block is gone and the single
 * section carries no count of its own, because a lone section's count IS the
 * page count.
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
        {error.message} The view endpoints are owner-only — use a signed-in session or an enrolled device credential.
      </BigState>
    )
  }
  if (!data) return <Loading what="the inbox" />

  return (
    <div className="document-view">
      <ViewHeader
        eyebrow="Inbox"
        title="Inbox"
        description="Questions your loops are holding for a person."
        meta={data.counts.total === 0 ? 'nothing waiting' : `${data.counts.total} waiting`}
      />

      {error && data && <Refusal error={error} />}

      {data.items.length === 0 ? (
        <Section tone="plain" title="Needs you">
          <Empty>Nothing is waiting on you. Loops are running; tasks are being picked up, verified and closed without you.</Empty>
        </Section>
      ) : (
        <Section tone="needs" title="Needs you">
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

/**
 * The one metadata line under a question, and what it is ALLOWED to say.
 *
 * It used to read `from <loop> next <loop> asked 2m ago`, where both loops were
 * the same loop rendered twice (a loop that asks a question is normally the loop
 * that will act on the answer) and the age was already on the row above it. The
 * rule now: state only what the row cannot.
 *
 *  - the asking loop and the age are on the ROW (title / source / time), so they
 *    are not repeated here;
 *  - the WATCHER appears only when it differs from the asker, which is the case
 *    where "who acts next" is genuinely a second fact;
 *  - a follow-up date appears only when there is one;
 *  - a second reason appears only when a future inbox arm produces one.
 *
 * With none of those true the line does not render at all, which is the common
 * case and the point.
 */
function InboxMeta({ item, onOpenLoop }: { item: InboxItem; onOpenLoop: (id: string) => void }) {
  const watcher = item.watcherLoop
  const handedOn = Boolean(watcher && watcher.id !== item.creator?.id)
  const extraReasons = item.reasons.slice(1)
  if (!handedOn && !item.task.followUpAt && extraReasons.length === 0) return null
  return (
    <p className="inbox-meta">
      {handedOn && (
        <span>
          next{' '}
          {watcher && !isDeletedLoop(watcher) ? (
            <button type="button" className="ws-link" onClick={() => onOpenLoop(watcher.id)}>
              {loopLabel(watcher)}
            </button>
          ) : (
            loopLabel(watcher, item.task.watcher)
          )}
        </span>
      )}
      {item.task.followUpAt && <When iso={item.task.followUpAt} prefix="follow-up" />}
      {extraReasons.length > 0 && <span>also: {extraReasons.map(reasonLabel).join(' · ')}</span>}
    </p>
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
  const primary = item.reasons[0] ?? 'question'

  const send = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await postVerdict(item.task.id, text.trim())
      // R-answer: the answer wakes the watcher. It JOINS an already-queued run
      // rather than stacking a twin, so say which happened.
      setQueued(result.run ? (result.run.alreadyQueued ? `joined the run already queued (${result.run.id})` : `queued ${result.run.id}`) : 'the answer is on the record; its watcher had no run to queue')
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
        icon="question"
        iconTone="question"
        title={item.task.title ?? item.task.id}
        source={
          <>
            {item.creator ? loopLabel(item.creator) : 'you'}
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
        {asking ? (
          <p className="inbox-question">
            <Glyph name="question" />
            {item.task.pendingQuestion}
          </p>
        ) : (
          <p className="inbox-floor">
            The question on this task was answered or withdrawn while you were reading. Refresh to drop it from the list.
          </p>
        )}

        <InboxMeta item={item} onOpenLoop={onOpenLoop} />

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
            {/* One muted line, and the full sentence on hover. The rule it states
                matters and never changes, so it does not need to hold a paragraph
                of standing copy under every question on the page. */}
            <p className="answer-note" title="Approve and Reject send exactly what is in the box — the platform never parses your words, only agents interpret them.">
              Sent verbatim · only agents interpret it
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
