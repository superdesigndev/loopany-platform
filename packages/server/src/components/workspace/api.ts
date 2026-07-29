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
  verdict?: { transition: string; label: string; obligation: string }
}

export interface LibraryView {
  categories: string[]
  artifacts: LibraryArtifact[]
  needsYou: number
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
}

export interface VerdictOk {
  ok: true
  replay: boolean
  status: string
  eventId: string
  closed: string[]
  actions: { id: string; kind: string; consequenceClass: string }[]
}

export interface VerdictFail {
  ok: false
  code: string
  message: string
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

export const fetchSummary = () => getJson<Summary>('/api/graph/summary')
export const fetchSystem = () => getJson<SystemView>('/api/graph/system')
export const fetchLibrary = () => getJson<LibraryView>('/api/graph/library')
export const fetchTimeline = () => getJson<TimelineView>('/api/graph/timeline')

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
