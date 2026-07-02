/**
 * fetch with a mandatory per-call timeout. undici (Node's fetch) lets a hung
 * connection stall for ~5 minutes by default — far too long for a daemon whose
 * poll heartbeat, sync/report pipeline, and status probes must degrade fast
 * when the server hangs. Every daemon fetch goes through here so that
 * rationale lives once; each call site keeps its own timeout budget.
 */

/** `fetch(url, init)` bounded by `timeoutMs`. A caller-supplied signal (e.g.
 *  the daemon's shutdown AbortController) is composed with the timeout via
 *  AbortSignal.any so either can abort the request. */
export function boundedFetch(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}
