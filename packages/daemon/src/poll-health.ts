export type PollFailureKind = "timeout" | "network" | "http" | "protocol";

export interface PollFailure {
  kind: PollFailureKind;
  detail: string;
  status?: number;
}

interface PollLog {
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]);

/** Turn fetch's platform-dependent abort/network errors into stable operator labels. */
export function classifyPollFailure(error: unknown): PollFailure {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { kind: "timeout", detail: error.name };
  }
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: { name?: unknown; code?: unknown; message?: unknown };
  } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "Error";
  const code = typeof candidate?.code === "string"
    ? candidate.code
    : typeof candidate?.cause?.code === "string" ? candidate.cause.code : undefined;
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  if (name === "TimeoutError" || name === "AbortError" || (code !== undefined && TIMEOUT_CODES.has(code))) {
    return { kind: "timeout", detail: code ?? name };
  }
  if (error instanceof SyntaxError) return { kind: "protocol", detail: message.slice(0, 160) };
  return { kind: "network", detail: code ?? message.slice(0, 160) };
}

/** One warning per distinct failure state, then one recovery summary. Repeated
 * identical failures are counted but silent so an outage cannot flood stderr. */
export class PollHealth {
  private failedAt: number | undefined;
  private failures = 0;
  private lastFailure: PollFailure | undefined;

  constructor(private readonly log: PollLog, private readonly now: () => number = Date.now) {}

  failure(failure: PollFailure, elapsedMs: number): void {
    this.failures += 1;
    const previous = this.lastFailure;
    const unchanged = previous?.kind === failure.kind
      && previous.detail === failure.detail
      && previous.status === failure.status;
    if (this.failedAt === undefined) {
      // The outage began when this attempt started, not when its timeout budget
      // finally elapsed. This keeps the recovery duration honest.
      this.failedAt = this.now() - Math.max(0, elapsedMs);
    }
    this.lastFailure = failure;
    if (unchanged) return;
    this.log.warn({
      kind: failure.kind,
      detail: failure.detail,
      status: failure.status,
      elapsedMs,
      ...(previous ? { previousKind: previous.kind, previousStatus: previous.status } : {}),
    }, previous ? "poll failure changed" : "poll degraded");
  }

  success(elapsedMs: number): void {
    if (this.failedAt === undefined) return;
    const outageMs = Math.max(0, this.now() - this.failedAt);
    const failures = this.failures;
    this.failedAt = undefined;
    this.failures = 0;
    this.lastFailure = undefined;
    this.log.info({ failures, outageMs, elapsedMs }, "poll recovered");
  }
}
