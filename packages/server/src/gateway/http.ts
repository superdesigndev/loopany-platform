/**
 * Machine-route ingress: read + parse a JSON request body under a hard size cap.
 * The gateway's per-field wire caps (WIRE_TEXT_CAP etc.) clip individual strings
 * AFTER parse — without this, an unbounded `request.json()` still buffers an
 * arbitrarily large body first. Framework-free (plain Request) so any machine
 * route can share it.
 */

/**
 * Body cap for the standard machine routes (poll / report / loop / agent-api).
 * 2MB — generously above the largest legitimate body: a report can carry a
 * 512KB taskFileContent (WIRE_TEXT_CAP) + a ~800KB transcript (200 steps ×
 * 4KB fields) + a 256KB cursor (CURSOR_CAP) ≈ 1.6MB; an editLoop/agent-api
 * payload maxes out around one or two 512KB content fields. The sync route has
 * its own, larger cap (SYNC_BODY_CAP — it inlines blob bytes).
 */
export const MACHINE_BODY_CAP = 2 * 1024 * 1024;

export type JsonBodyResult =
  | { kind: "ok"; body: unknown }
  | { kind: "too-large" }
  | { kind: "invalid" };

/**
 * Read + parse a JSON body, bounded by `maxBytes`: the declared content-length
 * is checked first (cheap reject for honest clients), then the actual text
 * length (code units ≤ UTF-8 bytes, so the cap is enforced within a small
 * constant factor — same basis the sync route always used). An unreadable or
 * empty body parses as `{}` (matching the old `request.json().catch(() => ({}))`);
 * unparseable text is reported as `invalid` so each route keeps its own policy
 * (fall back to `{}`, or 400).
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text().catch(() => "");
  if (text.length > maxBytes) return { kind: "too-large" };
  if (!text) return { kind: "ok", body: {} };
  try {
    return { kind: "ok", body: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}
