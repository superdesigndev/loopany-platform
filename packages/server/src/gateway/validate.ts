/**
 * Content-field validators/normalizers for a loop's ui / workflow / stateSchema.
 *
 * ANTI-DRIFT INVARIANT: the owner device-token edit surface (`createLoop`/
 * `editLoop` in `gateway/index.ts`) and the run-token `set-ui`/`set-workflow`/
 * `set-schema` surface (`applySet*` in `gateway/cli.ts`) MUST validate
 * identically - both import this ONE module, so the two write paths cannot
 * drift. Each validator returns a normalized value ready to feed
 * `store.updateLoop`, or a `{ ok: false, detail }` the caller maps to a
 * 400/rejection.
 */
import * as store from "../db/store.js";
import type { StateField } from "../db/schema.js";

/** Sanitize/normalize dashboard HTML → the stored value (or null to clear). */
export function validateUi(html: string): { ok: true; value: string | null } {
  return { ok: true, value: store.coerceUi(html) ?? null };
}

/** Validate + normalize the deterministic pre-stage JS → the stored value (or
 *  null to clear). A workflow body is NOT an ES module: the daemon runner
 *  (`workflow.ts` buildWrapper) interpolates it into an async arrow inside a
 *  generated ESM file, so top-level `export`/`import` (e.g. the Claude Code
 *  Workflow tool's `export const meta = {…}` header) is a PARSE error that
 *  kills the whole run before any line executes. We catch that at write time
 *  with a zero-exec parse check: the AsyncFunction constructor COMPILES the
 *  body (as the async-function body the runner will wrap it in, strict-mode
 *  matched to the ESM wrapper) but never RUNS it. Mirrors validateSchema's
 *  discriminated-union shape so the call sites map ok:false to a 400/rejection. */
export function validateWorkflow(body: string): { ok: true; value: string | null } | { ok: false; detail: string } {
  const src = body.trim();
  if (!src) return { ok: true, value: null }; // clearing the workflow is fine
  try {
    // Zero-exec: the constructor compiles but does not execute the body.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
    new AsyncFunction("prev", "agent", "tools", "fetch", '"use strict";\n' + src);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const hint = /export|import/.test(raw)
      ? " — a adScaile workflow is a plain script body (statements + `return {message?, state?}`), NOT an ES module and NOT the Claude Code Workflow tool format: remove any top-level `export`/`import` (e.g. `export const meta = {...}`). Use the injected globals `prev`/`agent`/`tools`/`fetch` directly."
      : "";
    return { ok: false, detail: `workflow has a syntax error: ${raw}${hint}` };
  }
  return { ok: true, value: src };
}

/** Validate a state schema. Accepts a JSON string (run-token path) or an
 *  already-parsed value (an `editLoop` JSON patch may carry the array inline).
 *  Enforces the additive rule: keys still bound by the UI or reported by
 *  recent runs may not be dropped. */
export async function validateSchema(loopId: string, input: unknown): Promise<{ ok: true; value: StateField[] } | { ok: false; detail: string }> {
  if (!(await store.getLoop(loopId))) return { ok: false, detail: "loop not found" };
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, detail: 'schema must be JSON, e.g. [{"key":"mrr","label":"MRR","unit":"$"}]' };
    }
  }
  const schema = store.coerceStateSchema(parsed);
  if (!schema) return { ok: false, detail: "schema must be a non-empty array of {key, label?, unit?}" };
  const have = new Set(schema.map((f) => f.key));
  const dropped = (await schemaKeysInUse(loopId)).filter((k) => !have.has(k));
  if (dropped.length) {
    return {
      ok: false,
      detail: `schema changes are additive — keep keys still in use: ${dropped.join(", ")} (bound by the UI or reported by recent runs).`,
    };
  }
  return { ok: true, value: schema };
}

async function schemaKeysInUse(loopId: string): Promise<string[]> {
  const keys = new Set<string>();
  const loop = await store.getLoop(loopId);
  if (loop?.ui) {
    for (const m of loop.ui.matchAll(/\{\{\s*(?:latest|state)\.([a-zA-Z0-9_-]+)[^}]*\}\}/g)) keys.add(m[1]!);
    for (const m of loop.ui.matchAll(/(?:series|key)=["']([^"']+)["']/g)) {
      for (const part of m[1]!.split(",")) {
        const key = part.trim().split(":")[0]?.trim();
        if (key) keys.add(key);
      }
    }
  }
  for (const run of await store.listRuns(loopId, 100)) {
    if (!run.state || typeof run.state !== "object") continue;
    for (const key of Object.keys(run.state as Record<string, unknown>)) keys.add(key);
  }
  return [...keys];
}
