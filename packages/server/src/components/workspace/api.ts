/**
 * The workspace's data layer: one typed fetcher per VIEW ENDPOINT, and nothing
 * else.
 *
 * There is no stitching here on purpose. Each screen has exactly one composed
 * endpoint (design §9, BFF style), so a fetcher is a URL, a status check and a
 * cast — if a screen ever needs a second call to be useful, the fix is to widen
 * its view endpoint, not to join on the client.
 *
 * Every payload carries `cursorSeq`: the `events.seq` the server assembled it
 * at. The live layer (`live.ts`) compares an incoming stream message's seq
 * against it, so a message describing a change already reflected in the data on
 * screen costs no refetch.
 */

export interface ViewPayload {
  cursorSeq: number
}

export type LoopRef = { id: string; title: string | null } | null

export interface EventShape {
  id: string
  seq: number
  objectId: string | null
  kind: string
  entrance: 'clock' | 'answer' | 'human' | 'agent'
  actor: string
  transition: string | null
  diff: Record<string, { old?: unknown; new?: unknown }> | null
  note: string | null
  ts: string
}

export interface InboxItem {
  task: {
    id: string
    title: string | null
    pendingQuestion: string | null
    body: string
    payload: Record<string, unknown>
    followUpAt: string | null
    watcher: string | null
    createdByLoop: string | null
    createdByRun: string | null
    createdAt: string
    updatedAt: string
  }
  reasons: string[]
  askedAt: string | null
  askedByRun: string | null
  creator: LoopRef
  watcherLoop: LoopRef
  /** The task's payload, echoed under the name the UI is CONTRACTED to render
   *  verbatim in an execution block (design §7 execution integrity). */
  execution: Record<string, unknown>
  recentEvents: EventShape[]
}

export interface InboxView extends ViewPayload {
  items: InboxItem[]
  counts: InboxCounts
  now: string
}

/** The §6 safety floor's counters. ONE branch today — a question waiting for a
 *  human — since the watcher rule retired the two that were predicated on an
 *  absent watcher (due-unwatched, the orphan floor). */
export interface InboxCounts {
  question: number
  total: number
}

export interface TaskRow {
  id: string
  title: string | null
  status: string
  followUpAt: string | null
  pendingQuestion: string | null
  watcher: string | null
  createdByLoop: string | null
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  due: boolean
  creator?: LoopRef
  watcherLoop?: LoopRef
}

export type BoardColumnKey = 'waiting' | 'due' | 'watched' | 'closed'

/** A board card: a task row plus the column the SERVER put it in. The client
 *  never re-derives the column — `kernel/taskBoard.ts` is the one mapping. */
export interface TaskCard extends TaskRow {
  column: BoardColumnKey
}

export interface BoardColumn {
  key: BoardColumnKey
  label: string
  /** The one sentence explaining why a card is here, authored server-side. */
  rule: string
  tasks: TaskCard[]
}

export interface TasksView extends ViewPayload {
  columns: BoardColumn[]
  loops: { id: string; title: string | null }[]
  counts: InboxCounts
  truncated: boolean
  now: string
}

export interface RunRow {
  id: string
  state: string
  scope: string
  reason: string | null
  startedAt: string | null
  finishedAt: string | null
  reportDoc: string | null
  summary: string | null
  costUsd: number | null
  attempts: number
}

export interface TaskView extends ViewPayload {
  task: Record<string, unknown> & { id: string; title: string | null; body: string; status: string; payload: Record<string, unknown>; pendingQuestion: string | null; watcher: string | null; followUpAt: string | null; createdAt: string; updatedAt: string; closedAt: string | null }
  execution: Record<string, unknown>
  due: boolean
  creator: LoopRef
  watcherLoop: LoopRef
  timeline: EventShape[]
  runs: RunRow[]
}

export interface LoopHealth {
  lastOutcome: string | null
  lastRunAt: string | null
  consecutiveFailures: number
  runs7d: { success: number; failure: number }
  costs7d: { usd: number }
}

export interface LoopListRow {
  id: string
  title: string | null
  status: string
  cron: string | null
  timezone: string | null
  cronText: string | null
  nextFire: string | null
  createdAt: string
  updatedAt: string
  health: LoopHealth
  openTasks: number
  questionsWaiting: number
}

export interface LoopsView extends ViewPayload {
  loops: LoopListRow[]
}

export interface CharterDiff {
  event: string
  seq: number
  ts: string
  actor: string
  entrance: string
  diff: Record<string, { old?: unknown; new?: unknown }>
}

export interface LoopView extends ViewPayload {
  loop: {
    id: string
    title: string | null
    status: string
    cron: string | null
    timezone: string | null
    cronText: string | null
    nextFire: string | null
    /** The BOUND directory every run of this loop executes in; null ⇒ the
     *  claiming daemon's own per-loop scratch dir. */
    workdir: string | null
    body: string
    payload: Record<string, unknown>
    createdAt: string
    updatedAt: string
  }
  health: LoopHealth
  charterHistory: CharterDiff[]
  openTasks: { watching: TaskRow[]; created: TaskRow[]; questions: TaskRow[] }
  recentRuns: RunRow[]
  events: EventShape[]
}

export interface DocRow {
  id: string
  title: string | null
  format: 'markdown' | 'html'
  key: string | null
  createdByLoop: string | null
  createdByRun: string | null
  creator: LoopRef
  createdAt: string
  updatedAt: string
  bytes: number
}

export interface DocsView extends ViewPayload {
  docs: DocRow[]
}

export interface DocView extends ViewPayload {
  doc: { id: string; title: string | null; body: string; format: 'markdown' | 'html'; payload: Record<string, unknown>; createdByLoop: string | null; createdByRun: string | null; createdAt: string; updatedAt: string }
  creator: LoopRef
  timeline: EventShape[]
}

export interface GraphNode {
  id: string
  /** `pool` is gone with the unclaimed state it stood for — see
   *  `kernel/views.ts` `systemGraphView`. */
  type: 'loop' | 'you'
  label: string | null
  status: string
  badges: {
    cadence?: string | null
    lastOutcome?: string | null
    lastRunAt?: string | null
    openTasks?: number
    questionsWaiting?: number
  }
}

export interface GraphEdge {
  from: string
  to: string
  kind: 'hands-off' | 'asks' | 'answers'
  count: number
}

export interface SystemGraphView extends ViewPayload {
  nodes: GraphNode[]
  edges: GraphEdge[]
  window: { days: number; since: string }
  now: string
}

/** A refusal from the kernel's flat envelope, surfaced to the screen verbatim —
 *  the CLI is a teacher and so is this UI: the hint is the useful half. */
export class ViewError extends Error {
  code: string
  hint?: string
  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
  const text = await response.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    const error = (body.error ?? body) as { code?: string; message?: string; hint?: string }
    throw new ViewError(error.code ?? `HTTP_${response.status}`, error.message ?? `request failed (${response.status})`, error.hint)
  }
  return body as T
}

export const fetchInbox = () => get<InboxView>('/api/views/inbox')
export const fetchLoops = () => get<LoopsView>('/api/views/loops')
export const fetchLoop = (id: string) => get<LoopView>(`/api/views/loop/${encodeURIComponent(id)}`)
export const fetchTasks = (query: Record<string, string> = {}) =>
  get<TasksView>(`/api/views/tasks${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`)
export const fetchTask = (id: string) => get<TaskView>(`/api/views/task/${encodeURIComponent(id)}`)
export const fetchDocs = () => get<DocsView>('/api/views/docs')
export const fetchDoc = (id: string) => get<DocView>(`/api/views/doc/${encodeURIComponent(id)}`)
export const fetchSystemGraph = (days?: number) =>
  get<SystemGraphView>(`/api/views/system-graph${days ? `?days=${days}` : ''}`)

/**
 * The verdict — the inbox's one write, and it is deliberately
 * plain: free text, recorded as the answer. Approve, reject and instructions are
 * all just the answer — the platform never parses it, only agents interpret it
 * (design §6). Nothing is executed here; the inbox changes task state, and only
 * runs change the world.
 */
export async function postVerdict(taskId: string, answer: string): Promise<{ run: { id: string; alreadyQueued: boolean } | null }> {
  return write<{ run: { id: string; alreadyQueued: boolean } | null }>(`/api/tasks/${encodeURIComponent(taskId)}/verdict`, 'POST', { answer }, 'the verdict was refused')
}

/**
 * The board's two writes, and they are the ONLY ones it performs.
 *
 * Both are existing kernel endpoints called exactly as the CLI calls them —
 * there is no board-specific write path, and there is deliberately no client
 * guess about legality: `board.ts` decides what may be DRAGGED, the kernel
 * decides what may HAPPEN, and a refusal from the second is rendered verbatim.
 */

/** `close` — the one task transition (types.ts `TRANSITIONS`). The note is
 *  required by the kernel, so the board must collect it before it asks. */
export async function postClose(taskId: string, note: string): Promise<{ changed: boolean; event: string | null }> {
  return write<{ changed: boolean; event: string | null }>(`/api/tasks/${encodeURIComponent(taskId)}/close`, 'POST', { note }, 'the close was refused')
}

/**
 * TRANSFER — a `watcher` facet PATCH, not a transition, and the only shape it
 * has: a loop id. `null` used to release a task to the unclaimed pool, and both
 * the pool and the call signature that reached it are gone (the kernel refuses
 * a null with `WATCHER_REQUIRED`). A task always names the loop that acts next;
 * the question this write answers is only ever "which one".
 */
export async function transferWatcher(taskId: string, watcher: string): Promise<{ changed: boolean }> {
  return write<{ changed: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}`, 'PATCH', { watcher }, 'the watcher change was refused')
}

/**
 * The loop page's one write: fire this loop off its cadence, now.
 *
 * Deliberately body-less — the loop already says what it does, so an
 * off-cadence run is a button, not a form (the route says the same). The
 * response is the queue's own answer: `queued` for a fresh run, or
 * `alreadyQueued` when this loop already had one waiting, since the kernel
 * allows exactly one queued run per loop (`runs_one_queued_idx`) and reports
 * the existing one rather than refusing.
 *
 * A paused or retired loop is refused by the SERVER with a teaching refusal,
 * and that is the whole point of not pre-hiding the button: the screen would
 * otherwise have to restate the lifecycle rule, and its copy would drift from
 * the kernel's.
 */
export interface RunNowResult {
  queued: boolean
  alreadyQueued: boolean
  run: { id: string; state: string | null; reason: string | null } | null
}

export async function postRunNow(loopId: string): Promise<RunNowResult> {
  return write<RunNowResult>(`/api/loops/${encodeURIComponent(loopId)}/run-now`, 'POST', {}, 'the run was refused')
}

/** The consequence a retire leaves behind: the open tasks that keep naming a
 *  loop which will never wake again. Present ONLY when there were any. */
export interface LifecycleWarning {
  code: string
  openTasks: number
  message: string
  hint: string
}

export interface LifecycleResult {
  changed: boolean
  loop: { id: string; status: string }
  warning?: LifecycleWarning
}

/**
 * `pause` / `resume` / `retire` — the operational lifecycle, human-only, and the
 * loop page's other writes.
 *
 * RETIRE WARNS, IT NEVER BLOCKS (captain ruling 2026-08-04). The server retires
 * the loop and reports what that cost; the screen's job is to confirm BEFORE —
 * because retirement is terminal — and then to show the warning it got back,
 * not to pre-empt it with a rule of its own. Repeating a verb that already
 * landed is a success with `changed: false`, so a retry costs nothing.
 */
export async function postLifecycle(loopId: string, verb: 'pause' | 'resume' | 'retire'): Promise<LifecycleResult> {
  return write<LifecycleResult>(`/api/loops/${encodeURIComponent(loopId)}/${verb}`, 'POST', {}, `the ${verb} was refused`)
}

async function write<T>(path: string, method: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    const error = (parsed.error ?? parsed) as { code?: string; message?: string; hint?: string }
    throw new ViewError(error.code ?? `HTTP_${response.status}`, error.message ?? fallback, error.hint)
  }
  return parsed as T
}
