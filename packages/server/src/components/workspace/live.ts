/**
 * FRESHNESS — one team-scoped SSE subscription, query invalidation, and a 30 s
 * polling fallback (design §9, API spec §7).
 *
 * The load-bearing property: **the stream carries no authoritative payload.** A
 * message is an INVALIDATION HINT — enough to decide which queries to refetch
 * (`objectId`, `objectKind`, `loopId`, `kind`) and nothing more. A client that
 * never receives a single message and simply polls the view endpoints every 30 s
 * is fully correct, only staler. That is what makes degraded mode a real
 * fallback rather than a broken mode, and it is why no view may ever depend on
 * the stream having been seen.
 *
 * Resume is EXPLICIT, not left to the browser. On an error the bus closes the
 * source and reopens at `?since=<last seq seen>`, so the resume cursor is the
 * bus's own state and is testable without a live server. (The server also
 * honors `Last-Event-ID`, which wins when both are present — a native
 * `EventSource` reconnect would therefore also resume losslessly; we do not rely
 * on it.)
 *
 * Everything external is an injected seam (`LiveDeps`), so the whole state
 * machine — resume cursor, reset, the two-errors-in-60 s degrade — runs in a
 * unit test with no network and no DOM.
 */

/** The thin `data` object of an `event: change` message (spec §7.2). */
export interface StreamMessage {
  seq: number
  id: string
  kind: string
  objectId: string | null
  objectKind: string | null
  loopId: string | null
  entrance: string
  ts: string
}

/** What a subscriber is told. `reset` and `poll` both mean "refetch everything";
 *  they are distinguished so the UI can explain WHY it went and refetched. */
export type LiveSignal =
  | { type: 'change'; message: StreamMessage }
  | { type: 'reset'; seq: number }
  | { type: 'poll' }

export type LiveStatus = 'connecting' | 'live' | 'degraded'

/** The `EventSource` surface the bus actually uses. */
export interface LiveSource {
  addEventListener(type: string, handler: (event: { data?: string }) => void): void
  close(): void
}

export interface LiveDeps {
  open(url: string): LiveSource
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
  setInterval(fn: () => void, ms: number): number
  clearInterval(handle: number): void
  now(): number
}

/** Server-controlled reconnect backoff; the stream sends `retry: 3000` at open. */
export const RETRY_MS = 3000
/** The degraded-mode refetch cadence design §9 accepts. */
export const POLL_MS = 30_000
/** Two errors inside this window means the stream is not working (spec §7.5). */
export const DEGRADE_WINDOW_MS = 60_000
export const DEGRADE_ERRORS = 2

export class WorkspaceLive {
  private deps: LiveDeps
  private source: LiveSource | undefined
  private reconnect: number | undefined
  private poller: number | undefined
  private errors: number[] = []
  private listeners = new Set<(signal: LiveSignal) => void>()
  private statusListeners = new Set<(status: LiveStatus) => void>()
  private stopped = false

  /** The resume cursor: the highest `seq` this client has actually seen. */
  cursor = 0
  status: LiveStatus = 'connecting'
  /** Every stream URL this bus has opened, in order — the resume proof. */
  readonly opened: string[] = []

  constructor(deps: LiveDeps, since = 0) {
    this.deps = deps
    this.cursor = since
  }

  /**
   * Idempotent and RESTARTABLE. React's StrictMode mounts an effect, tears it
   * down and mounts it again, so a bus that treated `stop()` as terminal would
   * be permanently dead in development — connected once, closed, never
   * reopened, with the UI stuck on "connecting" forever. Clearing the flag here
   * is what makes a remount a reconnect.
   */
  start(): void {
    if (this.source) return
    this.stopped = false
    this.connect()
    // The poll timer runs unconditionally and emits only while degraded, so a
    // stream that dies mid-session starts refetching without any extra wiring.
    this.poller = this.deps.setInterval(() => {
      if (this.status === 'degraded') this.emit({ type: 'poll' })
    }, POLL_MS)
  }

  stop(): void {
    this.stopped = true
    this.source?.close()
    this.source = undefined
    if (this.reconnect !== undefined) this.deps.clearTimeout(this.reconnect)
    if (this.poller !== undefined) this.deps.clearInterval(this.poller)
  }

  subscribe(listener: (signal: LiveSignal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (status: LiveStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => this.statusListeners.delete(listener)
  }

  private connect(): void {
    if (this.stopped) return
    const url = `/api/events/stream?since=${this.cursor}`
    this.opened.push(url)
    const source = this.deps.open(url)
    this.source = source
    source.addEventListener('open', () => {
      // A clean open clears the error history: two failures must be RECENT and
      // CONSECUTIVE to mean the stream is unusable.
      this.errors = []
      this.setStatus('live')
    })
    source.addEventListener('change', (event) => {
      const message = parseMessage(event.data)
      if (!message) return
      if (message.seq > this.cursor) this.cursor = message.seq
      this.setStatus('live')
      this.emit({ type: 'change', message })
    })
    source.addEventListener('reset', (event) => {
      // The server fell too far behind our cursor to replay. Never a silent gap:
      // it says so, and every view full-refetches from the new tail.
      const seq = Number((JSON.parse(event.data ?? '{}') as { seq?: unknown }).seq ?? 0)
      if (Number.isFinite(seq)) this.cursor = seq
      this.emit({ type: 'reset', seq: this.cursor })
    })
    source.addEventListener('error', () => this.onError())
  }

  private onError(): void {
    this.source?.close()
    this.source = undefined
    const now = this.deps.now()
    this.errors = [...this.errors, now].filter((at) => now - at <= DEGRADE_WINDOW_MS)
    if (this.errors.length >= DEGRADE_ERRORS) this.setStatus('degraded')
    if (this.stopped) return
    // Keep retrying the stream on the server-controlled backoff even while
    // degraded — degraded mode differs from live mode only in freshness.
    this.reconnect = this.deps.setTimeout(() => this.connect(), RETRY_MS)
  }

  private setStatus(status: LiveStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  private emit(signal: LiveSignal): void {
    for (const listener of this.listeners) listener(signal)
  }
}

function parseMessage(data: string | undefined): StreamMessage | undefined {
  if (!data) return undefined
  try {
    const parsed = JSON.parse(data) as Partial<StreamMessage>
    if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq)) return undefined
    return {
      seq: parsed.seq,
      id: String(parsed.id ?? ''),
      kind: String(parsed.kind ?? ''),
      objectId: parsed.objectId ?? null,
      objectKind: parsed.objectKind ?? null,
      loopId: parsed.loopId ?? null,
      entrance: String(parsed.entrance ?? ''),
      ts: String(parsed.ts ?? ''),
    }
  } catch {
    return undefined
  }
}

/** The browser wiring. Kept out of the class so the class stays DOM-free. */
export function browserDeps(): LiveDeps {
  return {
    open: (url) => new EventSource(url),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle),
    now: () => Date.now(),
  }
}

/**
 * Should this view refetch for this signal?
 *
 * `cursorSeq` is what makes the answer cheap: a message whose `seq` the payload
 * on screen was already assembled at (or after) describes a change the screen is
 * ALREADY showing, so it costs no request. Without it every refetch races the
 * stream.
 */
export function shouldRefetch(signal: LiveSignal, cursorSeq: number, affects?: (message: StreamMessage) => boolean): boolean {
  if (signal.type !== 'change') return true
  if (signal.message.seq <= cursorSeq) return false
  return affects ? affects(signal.message) : true
}
