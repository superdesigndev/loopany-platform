import { REFUSAL_STATUS, refusal, refusalResponse, type ApiRefusal } from "./refusals.js";
import type { ApiResult } from "./objectApi.js";

/**
 * THE REWRITE LINE'S BOOT ENTRANCE — call it first in every rewrite route.
 *
 * `ensureServer()` applies migrations and starts the schedulers (including the
 * `RunQueueScheduler` that fires this line's cadences), and it used to be reachable
 * ONLY from a legacy server fn. So on a rewrite-only stack nothing ever booted: a
 * fresh pglite dir 500'd with `relation "teams" does not exist`, and even against a
 * migrated database no loop ever fired, because the clock was never started. It is
 * idempotent and promise-cached on `globalThis`, so the cost after the first call is
 * one already-resolved await.
 *
 * The dynamic import keeps `boot.ts` (and the whole legacy gateway it pulls in) out
 * of the module graph of the kernel unit tests that import this file for its
 * response helpers.
 */
export async function ensureBooted(): Promise<void> {
  const { ensureServer } = await import("../server/boot.js");
  await ensureServer();
}

export function apiResponse(result: ApiResult<Record<string, unknown>>): Response {
  if (!result.ok) return refusalResponse(result.error);
  return Response.json(result.value, { status: result.status ?? 200 });
}

export async function rawArtifact(request: Request): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "text/markdown") return { ok: false, response: refusalResponse(refusal("INVALID_BODY", "this endpoint requires Content-Type: text/markdown", [], "send the artifact file as the raw request body"), { status: 415 }) };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) return { ok: false, response: refusalResponse(refusal("TOO_LARGE", "artifact body exceeds the 4 MB limit")) };
  return { ok: true, text };
}

export async function jsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 512 * 1024) return { ok: false, response: refusalResponse(refusal("TOO_LARGE", "JSON body exceeds the 512 KB limit")) };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false, response: refusalResponse(refusal("INVALID_BODY", "request body is not valid JSON")) }; }
}

/** `jsonBody` for an endpoint whose body is OPTIONAL (the loop lifecycle verbs
 *  take `{note?}` or nothing at all). An empty body resolves to `undefined`,
 *  which the handler reads as "no note" — never as malformed JSON. */
export async function optionalJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (!text.trim()) return { ok: true, value: undefined };
  if (Buffer.byteLength(text, "utf8") > 512 * 1024) return { ok: false, response: refusalResponse(refusal("TOO_LARGE", "JSON body exceeds the 512 KB limit")) };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false, response: refusalResponse(refusal("INVALID_BODY", "request body is not valid JSON")) }; }
}

export function authFailure(error: ApiRefusal): Response {
  return refusalResponse(error, { status: REFUSAL_STATUS[error.code], ...(error.code === "RATE_LIMITED" ? { headers: { "Retry-After": "1" } } : {}) });
}
