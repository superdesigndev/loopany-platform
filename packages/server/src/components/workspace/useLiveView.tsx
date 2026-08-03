import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import type { ViewPayload } from './api'
import { browserDeps, shouldRefetch, WorkspaceLive, type LiveStatus, type StreamMessage } from './live'

/**
 * React's half of the freshness layer: ONE bus per workspace mount, and a hook
 * that turns "an event happened" into "this view refetched".
 *
 * The hook owns nothing clever. It fetches once, subscribes, and refetches when
 * `shouldRefetch` says the signal is newer than the payload on screen and
 * relevant to this view. Stale data is KEPT on a failed refetch (the dashboard's
 * long-standing rule: a transient blip must not blank a working screen).
 */

const LiveContext = createContext<WorkspaceLive | null>(null)

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [bus] = useState(() => new WorkspaceLive(browserDeps()))
  useEffect(() => {
    bus.start()
    return () => bus.stop()
  }, [bus])
  return <LiveContext.Provider value={bus}>{children}</LiveContext.Provider>
}

export function useLiveStatus(): LiveStatus {
  const bus = useContext(LiveContext)
  const [status, setStatus] = useState<LiveStatus>(bus?.status ?? 'connecting')
  useEffect(() => bus?.onStatus(setStatus), [bus])
  return status
}

export interface LiveView<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  refresh: () => void
}

/**
 * One view endpoint, kept fresh.
 *
 * `key` identifies the request (a change to it refetches from scratch);
 * `affects` narrows which stream messages matter to this screen. Omitting
 * `affects` means "every event", which is correct — only chattier.
 */
export function useLiveView<T extends ViewPayload>(
  key: string,
  fetcher: () => Promise<T>,
  affects?: (message: StreamMessage) => boolean,
): LiveView<T> {
  const bus = useContext(LiveContext)
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  // Read inside callbacks without re-subscribing on every payload.
  const cursorRef = useRef(0)
  const fetcherRef = useRef(fetcher)
  const affectsRef = useRef(affects)
  fetcherRef.current = fetcher
  affectsRef.current = affects
  const inFlight = useRef(false)

  const load = useCallback(async (initial: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    if (initial) setLoading(true)
    try {
      const next = await fetcherRef.current()
      cursorRef.current = next.cursorSeq ?? 0
      setData(next)
      setError(undefined)
    } catch (cause) {
      // Keep whatever is on screen; a blip is not a reason to blank the page.
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    cursorRef.current = 0
    setData(undefined)
    void load(true)
  }, [key, load])

  useEffect(() => {
    if (!bus) return
    return bus.subscribe((signal) => {
      if (!shouldRefetch(signal, cursorRef.current, affectsRef.current)) return
      void load(false)
    })
  }, [bus, load])

  return { data, error, loading, refresh: () => void load(false) }
}

/** Common `affects` predicates, named so screens read declaratively. */
export const affectsTasks = (message: StreamMessage) => message.objectKind !== 'doc'
export const affectsObject = (id: string) => (message: StreamMessage) => message.objectId === id
export const affectsLoop = (id: string) => (message: StreamMessage) => message.objectId === id || message.loopId === id
export const affectsDocs = (message: StreamMessage) => message.objectKind === 'doc'
