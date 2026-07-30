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
  /** Open human-verdict obligations - what a person owes. */
  waiting?: number
  /** Open external-wait obligations - what the outside world owes us. Counted
   *  apart from `waiting` because only one of the two is a gate (design §12
   *  item 5), and this is the count the mirror poller moves on its own. */
  watching?: number
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
  /** An open external-wait this row holds ("waiting on GitHub to show it
   *  merged"). No button: the mirror poller clears it from an observation. */
  watching?: string
  /** When an observation last ingested facts for this mirror. */
  observedAt?: string
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

/**
 * Is anybody sensing? Since captain decision 10 the server holds no fetch loop, so
 * a workspace whose machine agent is not running looks exactly like one whose pull
 * requests have not changed. Computed from real observation stamps, never a
 * heartbeat, so it cannot claim freshness the rows do not have.
 */
export interface SensingHealth {
  mirrors: number
  unobserved: number
  stale: number
  lastObservedAt: string | null
}

export interface Summary {
  loops: number
  artifacts: number
  needsYou: number
  /** Open external-wait obligations - what the world owes us, not what you do. */
  watching: number
  /** Mirrors the machine agent keeps fresh. */
  mirrors: number
  events: number
  pendingActions: number
  attention: number
  notifications: number
  unreadNotifications: number
  /** Outward effects queued or in flight - decisions on their way out. */
  effectsInFlight: number
  sensing: SensingHealth
}

/**
 * An ATTENTION item - computed from a dead-lettered action, a parked chain or a
 * refused close. Visually and structurally separate from a verdict: "decide this"
 * and "this is stuck" are different asks, and one must not hide inside the other.
 */
export type AttentionKind = 'dead-letter' | 'chain-parked' | 'close-refused' | 'directive-failed'

export interface AttentionItem {
  id: string
  kind: AttentionKind
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
  counts: Record<AttentionKind, number>
}

/**
 * ONE OUTWARD WORK ORDER and what became of it - the surface that makes
 * "approve in the platform" honest.
 *
 * Without it a person clicks Approve, sees a notification, and still has to open
 * GitHub to find out whether anything actually happened. `pending` means no agent
 * has picked it up; `claimed` means a machine is on it right now; `done` carries
 * the URL of the thing that now exists out there because somebody approved it.
 */
export interface EffectRow {
  id: string
  kind: string
  state: string
  target: string
  resultUrl: string | null
  detail: string | null
  reason: string | null
  attempts: number
  createdAt: string
  age: string
  settledAt: string | null
  objectId: string | null
}

export interface EffectsView {
  items: EffectRow[]
  /** Queued or in flight - decisions on their way out of the building. */
  unsettled: number
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
export const fetchEffects = () => getJson<EffectsView>('/api/graph/effects')

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

// There is deliberately no `postPoll`. The server holds no GitHub transport since
// captain decision 10, so nothing here can make a sweep happen - sensing runs on the
// machine, and `summary.sensing` is how this UI tells the truth about whether it is.

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
