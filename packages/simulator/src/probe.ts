/**
 * The WORLD PROBE reader - cheap sandbox reads for a conditional event's `when`
 * predicate (§3.4). The world reacts to what the agent actually DID:
 *
 *   prs   - every PR the fake `gh` recorded, with the files each changed. The
 *           gh shim already derived `changedFiles` via `git diff base...head` at
 *           create time, so the probe just reads the JSON records (deterministic,
 *           no re-shelling of git).
 *   tasks - the current task states via `lk list --json` (id/status/assignee).
 *
 * Kept a pure reader over injectable inputs where it matters: the task list is
 * obtained by running the CLI (the engine passes a runner), so a test drives it
 * with a fake instead of a real `lk`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorldProbe } from "./types.js";

/** Read the recorded PRs from `<sandbox>/github/pr-*.json`. Absent dir = []. */
export function readRecordedPrs(sandboxRoot: string): WorldProbe["prs"] {
  const dir = join(sandboxRoot, "github");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^pr-\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>)
    .map((r) => ({
      number: Number(r.number),
      branch: String(r.branch ?? ""),
      changedFiles: Array.isArray(r.changedFiles) ? (r.changedFiles as string[]) : [],
    }))
    .sort((a, b) => a.number - b.number);
}

/** Parse the `lk list --json` stdout into the probe's task shape. The tree view
 *  (no filter) is a nested structure; we accept EITHER a flat array of task
 *  objects or a tree with `children`, flattening tasks out of it. A parse failure
 *  yields [] (a probe read must never throw and abort a day). */
export function parseTasks(listJson: string): WorldProbe["tasks"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return [];
  }
  const out: WorldProbe["tasks"] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.id === "string" && (o.archetype === "task" || o.status !== undefined)) {
        out.push({
          id: o.id,
          status: typeof o.status === "string" ? o.status : "",
          assignee: typeof o.assignee === "string" ? o.assignee : null,
        });
      }
      if (Array.isArray(o.children)) for (const c of o.children) visit(c);
    }
  };
  visit(parsed);
  return out;
}

/** Resolve a workspace-relative path, path-jailed. Returns null on a traversal
 *  outside the workspace (a conditional read must never reach the real fs). */
function jailed(workspace: string, rel: string): string | null {
  const target = resolve(workspace, rel);
  const r = relative(resolve(workspace), target);
  return r.startsWith("..") ? null : target;
}

/** Read a workspace file for a conditional event (§3.4). Absent/traversal = "".
 *  Bounded read (the products these gate are small mirrors/pages), never throws. */
export function readWorkspaceFile(workspace: string, rel: string): string | null {
  const target = jailed(workspace, rel);
  if (target === null || !existsSync(target)) return null;
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/** True when `<workspace>/<rel>` is a directory with at least one FILE anywhere
 *  under it. Absent/traversal/not-a-dir = false, never throws. */
export function workspaceDirHasFiles(workspace: string, rel: string): boolean {
  const target = jailed(workspace, rel);
  if (target === null || !existsSync(target)) return false;
  try {
    return readdirSync(target, { withFileTypes: true, recursive: true }).some((e) => e.isFile());
  } catch {
    return false;
  }
}

/** Build a probe: recorded PRs (fs) + task states (the caller runs `lk list
 *  --json` and passes its stdout) + cheap workspace file reads. */
export function buildProbe(sandboxRoot: string, listJson: string, workspace: string): WorldProbe {
  return {
    prs: readRecordedPrs(sandboxRoot),
    tasks: parseTasks(listJson),
    fileExists: (rel) => readWorkspaceFile(workspace, rel) !== null,
    fileContains: (rel, substring) => (readWorkspaceFile(workspace, rel) ?? "").includes(substring),
    dirHasFiles: (rel) => workspaceDirHasFiles(workspace, rel),
  };
}
