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

/**
 * A watcher or creator, as the server resolved it (`kernel/loopRefs.ts`).
 * `source` says which world answered: the kernel's own loop objects, the
 * production `loops` table, or NEITHER — `missing` is the tombstone for a loop
 * that was deleted out from under a task that still names it. Render it through
 * `loopLabel.ts`, never by reaching for `title ?? id` inline.
 */
export type LoopRef = { id: string; title: string | null; source?: 'kernel' | 'prod' | 'missing' } | null

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

/**
 * A TASK reference — the parent pointer, resolved server-side.
 *
 * `missing: true` is the tombstone, exactly as `LoopRef`'s `source: 'missing'`
 * is: a parent that can no longer be read is a FACT, and rendering it as `null`
 * would say "this task has no parent", which is a different claim.
 */
export type TaskRef = { id: string; title: string | null; status: string | null; missing?: true } | null

export interface TaskRow {
  id: string
  title: string | null
  status: string
  followUpAt: string | null
  pendingQuestion: string | null
  watcher: string | null
  /** The parent TASK's id, or null for a root (`objects.parent_id`). Hierarchy
   *  is ORTHOGONAL to the watcher: a child keeps its own watcher, its own
   *  follow-up and its own end. */
  parentId?: string | null
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
  /** The parent, resolved (title included) so a chip never prints a bare id.
   *  Absent on an older payload; null on a root. */
  parent?: TaskRef
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
  counts: InboxCounts
  truncated: boolean
  now: string
}

export interface RunRow {
  id: string
  state: string
  /** Rich loop rows add these; task-linked run rows may omit them. */
  status?: string | null
  outcome?: string | null
  role?: string
  scope: string
  reason: string | null
  startedAt: string | null
  finishedAt: string | null
  reportDoc: string | null
  summary: string | null
  costUsd: number | null
  attempts: number
  progress: { step: number; label: string; at?: string } | null
}

export interface LoopRunRow extends RunRow {
  role: 'exec' | 'evolve' | 'edit' | string
  outcome: string | null
  status: string | null
  durationMs: number | null
  error: string | null
  metrics: Record<string, number | string> | null
  sessionId: string | null
  artifacts: Array<{ path: string; kind: 'created' | 'edited' }> | null
}

export interface LoopStateField {
  key: string
  label?: string
  unit?: string
}

export interface LoopChannel {
  id: string
  type: string
  name: string
}

/**
 * A MIRROR — a pointer to something outside this system, composed onto an
 * object's view by reverse lookup (the association lives on the mirror side).
 *
 * Note what is NOT here, and could not be: there is no state, no `merged`, no
 * `lastChecked`. A mirror tells you WHERE to look, never WHAT state it is in,
 * and the server's schema has nowhere to record one. `href` is resolved
 * SERVER-side so no client re-derives an external URL.
 */
export interface MirrorRef {
  id: string
  externalKind: string
  coords: string
  note: string | null
  href: string | null
  attachedTo: string[]
  createdByLoop: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskView extends ViewPayload {
  task: Record<string, unknown> & { id: string; title: string | null; body: string; status: string; payload: Record<string, unknown>; pendingQuestion: string | null; watcher: string | null; followUpAt: string | null; createdAt: string; updatedAt: string; closedAt: string | null }
  execution: Record<string, unknown>
  mirrors: MirrorRef[]
  due: boolean
  creator: LoopRef
  watcherLoop: LoopRef
  /** Both directions of the hierarchy, as NAVIGABLE references. There is no
   *  roll-up in either: a parent is closed by its watcher, never by its last
   *  child, so these point at other work rather than deriving this task's state. */
  parent?: TaskRef
  children?: TaskRow[]
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
    enabled: boolean
    notify: 'auto' | 'always' | 'never'
    channelId: string | null
    model: string | null
    agent: 'claude-code' | 'codex' | 'grok'
    allowControl: boolean
    ui: string | null
    stateSchema: LoopStateField[]
    hasWorkflow: boolean
    /** The BOUND directory every run of this loop executes in; null ⇒ the
     *  claiming daemon's own per-loop scratch dir. */
    workdir: string | null
    body: string
    payload: Record<string, unknown>
    createdAt: string
    updatedAt: string
    /** S3 resolves every live loop from the production roster. `kernel` remains
     *  in the transitional wire union only until the S5 cleanup. */
    source: 'kernel' | 'prod'
  }
  health: LoopHealth
  runCount: number
  totalCostUsd: number | null
  charterHistory: CharterDiff[]
  openTasks: { watching: TaskRow[]; created: TaskRow[]; questions: TaskRow[] }
  recentRuns: LoopRunRow[]
  channels: LoopChannel[]
  mirrors: MirrorRef[]
  events: EventShape[]
}

export interface TranscriptStep {
  kind: 'text' | 'tool' | 'result'
  text?: string
  name?: string
  input?: string
}

export interface LoopRunView extends ViewPayload {
  loop: { id: string; title: string | null }
  run: LoopRunRow & {
    usage: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      numTurns?: number
    } | null
    control: Array<{ command: string; args: unknown; result: string; detail?: string }> | null
    transcript: TranscriptStep[]
  }
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
  mirrors: MirrorRef[]
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
export const fetchLoopRun = (id: string) => get<LoopRunView>(`/api/views/run/${encodeURIComponent(id)}`)
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
 * THE DIRECTIVE — a person telling the watching loop what to do, unprompted.
 *
 * The mirror image of the verdict: `postVerdict` REPLIES to a question the loop
 * asked, this one SPEAKS FIRST. Both queue one run for the watcher with the task
 * in scope; the difference is who opened the conversation, and that is why they
 * are two endpoints rather than one with a mode flag.
 *
 * The platform never parses it. The run executes the INTENT against external
 * reality first and the kernel's records last — "drop this bet" means close the
 * PR, clean up, and only then close the task.
 */
export async function postDirective(taskId: string, directive: string): Promise<{ run: { id: string; alreadyQueued: boolean } | null; notice?: { message: string } }> {
  return write<{ run: { id: string; alreadyQueued: boolean } | null; notice?: { message: string } }>(`/api/tasks/${encodeURIComponent(taskId)}/directive`, 'POST', { directive }, 'the directive was refused')
}

/**
 * THERE IS NO `postClose`, and its absence is the point (captain direction
 * 2026-08-04).
 *
 * The expected end of a task is that its WATCHER closes it — from its own
 * workflow logic, or in response to a directive left here. A human closing a
 * task from this screen settles the kernel's record while the external world it
 * describes carries on unchanged: the PR is still open, the branch is still
 * there, and the loop that would have cleaned them up is now looking at a closed
 * task and will never act again. `loopany task close` remains as the deep
 * emergency hatch for a broken watcher, documented as one, where the person
 * running it can see they are taking on the reconciliation themselves.
 *
 * The board's remaining writes are `postVerdict` and `postDirective` — both
 * existing kernel endpoints called exactly as the CLI calls them. There is no
 * board-specific write path, and deliberately no client guess about legality:
 * the kernel decides what may HAPPEN and a refusal is rendered verbatim.
 *
 * There WAS a third, a `watcher` facet PATCH that handed a task to another loop,
 * and it is GONE (captain ruling 2026-08-05) — as is the kernel capability
 * behind it, which now refuses a watcher rewrite with `WATCHER_IMMUTABLE`. A
 * task's watcher is settled when the task is created; do not add a helper here
 * for changing it without the ruling that asks for one.
 */

/**
 * The loop page's one write: fire this loop off its cadence, now.
 *
 * Deliberately body-less — the loop already says what it does, so an
 * off-cadence run is a button, not a form (the route says the same). The
 * response is the queue's own answer: `queued` for a fresh run, or
 * `alreadyQueued` when this loop already had one open, since the trigger seam
 * transactionally joins the existing pending/running run rather than refusing.
 *
 * Pause governs cadence, not an explicit fire: a paused loop runs once and
 * stays paused. A retired kernel loop is still refused by the server.
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
 * `pause` / `resume` — the operational lifecycle, human-only. A pause may
 * return u16's watched-task consequence; that is a successful write carrying a
 * warning, never a client-side precondition.
 */
export async function postLifecycle(loopId: string, verb: 'pause' | 'resume'): Promise<LifecycleResult> {
  return write<LifecycleResult>(`/api/loops/${encodeURIComponent(loopId)}/${verb}`, 'POST', {}, `the ${verb} was refused`)
}

export interface LoopConfigPatch {
  name?: string
  cron?: string
  timezone?: string | null
  notify?: 'auto' | 'always' | 'never'
  channelId?: string | null
  model?: string | null
  agent?: 'claude-code' | 'codex' | 'grok'
}

export interface LoopConfigResult {
  changed: boolean
  config: {
    name: string
    cron: string
    timezone: string | null
    notify: 'auto' | 'always' | 'never'
    channelId: string | null
    model: string | null
    agent: 'claude-code' | 'codex' | 'grok'
  }
}

export async function patchLoopConfig(loopId: string, patch: LoopConfigPatch): Promise<LoopConfigResult> {
  return write<LoopConfigResult>(`/api/loops/${encodeURIComponent(loopId)}/config`, 'PATCH', patch, 'the loop config was refused')
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
