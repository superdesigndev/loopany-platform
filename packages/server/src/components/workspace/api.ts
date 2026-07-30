/**
 * The workspace demo's client-side view types + fetchers.
 *
 * The types MIRROR `graph/workspace/read.ts` deliberately rather than importing
 * it: that module pulls in the Drizzle handle, and a type-only import from a
 * route component is one refactor away from dragging the database into the
 * client bundle. Everything crosses the wire as JSON from `/api/graph/*`.
 */

export type SystemNodeKind = 'sensor' | 'loop' | 'gate' | 'human' | 'machine'

export interface SystemNode {
  id: string
  kind: SystemNodeKind
  name: string
  eyebrow: string
  stat: string
  badge?: string
  rank: number
  yOffset?: number
  planned?: boolean
  activity?: 'running' | 'waiting' | 'idle' | 'online'
  band: string
  bandLabel?: string
  waiting?: number
  artifactIds?: string[]
}

export interface SystemEdge {
  id: string
  source: string
  target: string
  label: string
  relation?: boolean
  shared?: boolean
  planned?: boolean
  animated?: boolean
}

export interface SystemView {
  nodes: SystemNode[]
  edges: SystemEdge[]
  bands: string[]
}

export interface LibraryArtifact {
  id: string
  category: string
  title: string
  source: string
  state: string
  age: string
  icon: 'pr' | 'post' | 'report' | 'doc'
  kind: 'document' | 'mirror'
  html?: string
  sourceUrl?: string
  externalLabel?: string
  needsHuman: boolean
  /** The verdict a person owes: which SHEPHERD task to move, and how. Content
   *  itself has no lifecycle, so this is never the artifact's own id. */
  verdict?: { objectId: string; transition: string; label: string; obligation: string }
  /** False when the bytes live in the artifact store, not in this database. */
  bodyAvailable: boolean
  path?: string
  originalType?: string
  /** How the body was projected to HTML: a v1-format artifact, plain Markdown
   *  (no front matter), or a data/source file shown as a code block. */
  renderMode?: 'artifact' | 'markdown' | 'code'
  /** Why there is no body, when there is none. Always a real condition. */
  bodyAbsentReason?: string
  /** The doc's `published` field - a field, not a state. */
  published: boolean
}

export interface LibraryView {
  categories: string[]
  artifacts: LibraryArtifact[]
  needsYou: number
  total: number
  truncated: number
}

export interface TimelineEntry {
  id: string
  ts: string
  actor: string
  message: string
  transition: string | null
  entrance: string
  actorId: string
  band: string
  kind: 'decision' | 'artifact' | 'observe' | 'run'
  objectId: string | null
}

export interface TimelineView {
  events: TimelineEntry[]
  total: number
}

export interface Summary {
  loops: number
  artifacts: number
  needsYou: number
  events: number
  pendingActions: number
  attention: number
  notifications: number
  unreadNotifications: number
}

/**
 * An ATTENTION item - computed from a dead-lettered action, a parked chain or a
 * refused close. Visually and structurally separate from a verdict: "decide this"
 * and "this is stuck" are different asks, and one must not hide inside the other.
 */
export interface AttentionItem {
  id: string
  kind: 'dead-letter' | 'chain-parked' | 'close-refused'
  ref: string
  title: string
  detail: string
  reason: string
  raisedAt: string
  objectId: string | null
  subject: string | null
  retryable: boolean
  actionKind?: string
  attempts?: number
}

export interface AttentionView {
  items: AttentionItem[]
  counts: Record<'dead-letter' | 'chain-parked' | 'close-refused', number>
}

/** What the `notify` action produced - a verdict's visible consequence. */
export interface NotificationRow {
  id: string
  title: string
  body: string | null
  channel: string
  createdAt: string
  age: string
  read: boolean
  objectId: string | null
}

export interface NotificationsView {
  items: NotificationRow[]
  unread: number
}

export interface VerdictOk {
  ok: true
  replay: boolean
  status: string
  eventId: string
  closed: string[]
  actions: { id: string; kind: string; consequenceClass: string }[]
  /** What the verdict CAUSED, as reported by the outbox pass that ran with it. */
  effects?: { claimed: number; done: number; deadLettered: number }
}

export interface VerdictFail {
  ok: false
  code: string
  message: string
}

export type ResolveOk = { ok: true; verb: 'acknowledge' | 'retry'; eventId: string; replay: boolean; detail: string }
export type ResolveFail = { ok: false; code: string; message: string }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

export const fetchSummary = () => getJson<Summary>('/api/graph/summary')
export const fetchSystem = () => getJson<SystemView>('/api/graph/system')
export const fetchLibrary = () => getJson<LibraryView>('/api/graph/library')
export const fetchTimeline = () => getJson<TimelineView>('/api/graph/timeline')
export const fetchAttention = () => getJson<AttentionView>('/api/graph/attention')
export const fetchNotifications = () => getJson<NotificationsView>('/api/graph/notifications')

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return (await res.json()) as T
}

/** Resolve an attention item. `acknowledge` says "seen, not happening"; `retry`
 *  re-queues a dead-lettered action - and deliberately does NOT silence it, so a
 *  second failure comes back. */
export const postAttention = (item: AttentionItem, verb: 'acknowledge' | 'retry') =>
  postJson<ResolveOk | ResolveFail>('/api/graph/attention', { kind: item.kind, ref: item.ref, verb })

export const postNotificationsRead = () => postJson<{ ok: true; marked: number }>('/api/graph/notifications/read')

/** Run one outbox pass now. The executor loops on its own; this is for a demo or
 *  a check that wants the effect immediately rather than within a tick. */
export const postDrain = () =>
  postJson<{ ok: true; claimed: number; done: number; failed: number; deadLettered: number }>('/api/graph/drain')

/**
 * The one write. A refusal comes back as a 409 with the transition seam's own
 * typed code, which is exactly what the UI should show — the engine decided, not
 * the client.
 */
export async function postVerdict(objectId: string, transition: string): Promise<VerdictOk | VerdictFail> {
  const res = await fetch('/api/graph/verdict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId, transition }),
  })
  return (await res.json()) as VerdictOk | VerdictFail
}
