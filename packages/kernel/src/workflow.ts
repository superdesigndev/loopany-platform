import type { WorkflowDefinition } from "./types.js";

export const LOOPANY_WORKFLOW_FORMAT = "loopany-js-v1" as const;
export const WORKFLOW_SOURCE_MAX_BYTES = 512 * 1024;

export type WorkflowValidation =
  | { ok: true; value: WorkflowDefinition }
  | { ok: false; message: string };

/** Validate the original Loopany deterministic pre-stage protocol without
 * executing it. The daemon interpolates `source` as an async function body,
 * hence top-level await/return are legal while import/export are not. */
export function validateWorkflowDefinition(input: unknown): WorkflowValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "workflow must be {format, source} or null" };
  }
  const value = input as { format?: unknown; source?: unknown };
  if (value.format !== LOOPANY_WORKFLOW_FORMAT) {
    return { ok: false, message: `workflow.format must be \"${LOOPANY_WORKFLOW_FORMAT}\"` };
  }
  if (typeof value.source !== "string" || !value.source.trim()) {
    return { ok: false, message: "workflow.source must be a non-empty string" };
  }
  if (new TextEncoder().encode(value.source).byteLength > WORKFLOW_SOURCE_MAX_BYTES) {
    return { ok: false, message: `workflow.source exceeds ${WORKFLOW_SOURCE_MAX_BYTES} bytes` };
  }
  const source = value.source.trim();
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
    new AsyncFunction("prev", "agent", "tools", "fetch", `"use strict";\n${source}`);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const hint = /export|import/.test(raw)
      ? " - loopany-js-v1 is an async function body, not an ES module; remove top-level import/export"
      : "";
    return { ok: false, message: `workflow has a syntax error: ${raw}${hint}` };
  }
  return { ok: true, value: { format: LOOPANY_WORKFLOW_FORMAT, source } };
}
