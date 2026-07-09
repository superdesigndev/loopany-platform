/**
 * Latest published @crewlet/adscaile version — a cached, fail-silent lookup of the
 * npm dist-tag `latest`, so the web can tell a user their daemon is outdated and
 * show the exact update command.
 *
 * Zero-exec invariant: this is a plain HTTP GET against the public npm registry —
 * the server runs no LLM and executes no user code. It NEVER surfaces an error:
 * if npm is unreachable/slow/garbage, the cache simply stays as-is (undefined at
 * first) and the web shows no update hint. Bounded timeout + ~1h in-memory cache
 * so the machine-list hot path never blocks on the network.
 *
 * The fetch is injectable (mirroring the gateway's injectable notifier/blobStore)
 * so tests need no network: construct a `LatestDaemonVersion` with a fake fetch
 * and `now`, or call the pure `fetchNpmLatest` directly.
 */

const NPM_URL = "https://registry.npmjs.org/@crewlet/adscaile";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // ~1h
const FETCH_TIMEOUT_MS = 4000;

type FetchLike = typeof fetch;
type NowFn = () => number;

/**
 * One npm `latest` read — bounded + fail-silent. Returns the version string or
 * null (unreachable/timeout/malformed). Pure w.r.t. the injected fetch, so it's
 * directly unit-testable with no network.
 */
export async function fetchNpmLatest(fetchImpl: FetchLike, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(NPM_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" }, // slim dist-tags doc
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = body?.["dist-tags"]?.latest;
    return typeof latest === "string" && latest.trim() ? latest.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In-memory cached accessor. `get()` returns the currently cached value (null
 * until the first successful fetch) and, when the cache is stale, kicks off a
 * background refresh — it never blocks the caller and never throws. A single
 * refresh is in-flight at a time (concurrent `get()`s share it).
 */
export class LatestDaemonVersion {
  private cached: string | null = null;
  private fetchedAt = 0;
  private inflight: Promise<string | null> | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: NowFn = Date.now,
  ) {}

  /** Cached latest version, refreshing in the background when stale. Non-blocking. */
  get(): string | null {
    if (this.now() - this.fetchedAt >= this.ttlMs) void this.refresh();
    return this.cached;
  }

  /** Force a refresh and resolve with the (possibly unchanged) cached value.
   *  Await-able for tests; production callers use `get()`. Never throws. */
  async refresh(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const v = await fetchNpmLatest(this.fetchImpl);
      // A failed read (null) keeps the last good value AND advances the stamp,
      // so a flapping registry doesn't hammer npm on every machine-list poll.
      this.fetchedAt = this.now();
      if (v) this.cached = v;
      return this.cached;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}

/** Process-wide singleton the machine server fns read (fail-silent, cached). */
export const latestDaemonVersion = new LatestDaemonVersion();
