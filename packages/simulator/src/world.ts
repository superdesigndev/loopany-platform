/**
 * The WORLD writer - applies a scenario's mirror-file events onto the sandbox.
 *
 * Mirrors are the harness's one-way channel for "the outside world" (§1 of the
 * design doc): the agent only READS `mirrors/*.md`; the harness writes them.
 * This module owns exactly that write (path-jailed to the workspace); the
 * `human-note` WorldEvent variant is a CLI command and lives in the engine.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { WorldEvent } from "./types.js";

/** Substitute `{{sandbox}}` in scenario TEXT with the sandbox root. Scenario data
 *  templates the plant-repo path (e.g. a releases.md entry naming
 *  `{{sandbox}}/repos/superdesign-web`) so a mirror can point the agent at the
 *  real on-disk stand-in repo without the scenario knowing the temp dir. */
export function substituteSandbox(text: string, sandboxRoot: string): string {
  return text.split("{{sandbox}}").join(sandboxRoot);
}

/** Apply a `mirror-write` event. `path` is resolved UNDER the workspace root and
 *  a traversal outside it throws (a scenario is trusted, but a jail keeps a typo
 *  from writing over the real fs). */
export function applyMirrorWrite(
  workspace: string,
  event: Extract<WorldEvent, { kind: "mirror-write" }>,
  sandboxRoot?: string,
): void {
  const target = resolve(workspace, event.path);
  const rel = relative(resolve(workspace), target);
  if (rel.startsWith("..") || resolve(workspace) === target) {
    throw new Error(`mirror-write path "${event.path}" escapes the workspace`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const sub = (t: string): string => (sandboxRoot ? substituteSandbox(t, sandboxRoot) : t);
  if (event.content !== undefined) {
    writeFileSync(target, sub(event.content));
  } else if (event.append !== undefined) {
    appendFileSync(target, sub(event.append));
  } else {
    throw new Error(`mirror-write "${event.path}" has neither content nor append`);
  }
}

/** Build the `lk note` argv for a `human-note` event. The actor rides via the
 *  `LOOPANY_ACTOR` ENV (see humanNoteEnv), NOT `--actor`: the CLI's resolveActor
 *  promotes ANY `--actor`/`--session` to agent-run provenance, so `--actor tim`
 *  would mislabel a genuine human reply as an agent action. Setting only
 *  LOOPANY_ACTOR (no session) keeps entrance="human" with the named actorId. */
export function humanNoteArgv(
  event: Extract<WorldEvent, { kind: "human-note" }>,
  sandboxRoot?: string,
): string[] {
  const text = sandboxRoot ? substituteSandbox(event.text, sandboxRoot) : event.text;
  return ["note", event.task, text];
}

/** The env override that stamps a human-note with the reply's actor as a HUMAN. */
export function humanNoteEnv(event: Extract<WorldEvent, { kind: "human-note" }>): Record<string, string> {
  return { LOOPANY_ACTOR: event.actor };
}

/** The mirrors dir under a workspace (created lazily by writes; exported for
 *  tests / snapshot copy). */
export function mirrorsDir(workspace: string): string {
  return join(workspace, "mirrors");
}
