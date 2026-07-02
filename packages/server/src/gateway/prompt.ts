/**
 * Builds the exec-loop standing system prompt + per-run task on the SERVER, to
 * ship inside a delivery (the machine just writes the prompt to a file and runs
 * claude with it). Ported from c0's loop-prompt.ts, bound to the new Loop row
 * and the renamed `loopany` CLI. Prompt prose lives as markdown loaded +
 * `{{token}}`-filled here. ALL prompt prose now lives under src/skill/: the public
 * authoring trio (create/update/evolve) in skill/references/, and the INTERNAL
 * run prompts (exec-loop, edit) in skill/run/ — server-side run-dispatch only,
 * never served or bundled. The `evolve` text is the SINGLE source of truth shared
 * with the installable agent skill (skill/references/evolve.md) — run-dispatch and
 * the skill read the same file, so the evolution guidance can't drift. `edit` is a
 * run-token verb prompt with no authoring twin (see skill/references/update.md for
 * the authoring CLI). §4 of exec-loop is ONE static section for every loop — the
 * prompt does NOT branch on `allowControl`; it tells the run to consult `loopany
 * show` (which reports the effective self-schedule capability) before nudging the
 * cadence, and the run's self-schedule surface is just reschedule + set-cron.
 */
import type { Loop, Run, StateField } from "../db/schema.js";

// Inlined at build time (Vite ?raw) so the prompt prose ships inside the nitro
// bundle. Reading them from disk at runtime broke in prod: nitro bundles JS only,
// so the `*.md` source files don't exist under .output and poll() threw ENOENT.
// `?raw` resolves identically from skill/run/ as it did from scheduler/prompts/.
import execLoop from "../skill/run/exec-loop.md?raw";
import execTrigger from "../skill/run/exec-trigger.md?raw";
import evolve from "../skill/references/evolve.md?raw";
import edit from "../skill/run/edit.md?raw";

const PROMPTS: Record<string, string> = {
  "exec-loop": execLoop,
  "exec-trigger": execTrigger,
  evolve,
  edit,
};

function loadPrompt(name: string): string {
  const v = PROMPTS[name];
  if (v === undefined) throw new Error(`unknown prompt: ${name}`);
  return v.trim();
}

function fillVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

/** One-line human description of a loop's metric schema: `key (unit) — label; …`. */
function formatSchemaFields(schema: StateField[]): string {
  return schema.map((f) => `${f.key}${f.unit ? ` (${f.unit})` : ""}${f.label ? ` — ${f.label}` : ""}`).join("; ");
}

/** Standing instructions injected via `--append-system-prompt-file`. */
export function buildLoopSystemPrompt(loop: Loop): string {
  const name = loop.name || loop.id;
  const taskFile = loop.taskFile ?? "(none — work from the instruction you were given)";
  const schema = loop.stateSchema ?? [];
  const stateLine = schema.length
    ? `loopany report --status <s> --state '{${schema.map((f) => `"${f.key}":<n>`).join(",")}}'
  # record this run's metrics for the trend chart. Fields (keys must match, values must be finite numbers):
  #   ${formatSchemaFields(schema)}
  # report a subset if you only observed some; big payloads: --state-file <path>.`
    : `loopany report --status new --sample <number>     # optional single metric for charts`;
  return fillVars(loadPrompt("exec-loop"), { name, taskFile, stateLine });
}

/**
 * The per-run user turn — a fixed STATIC trigger (no more per-loop `task` column,
 * removed in batch 2). The whole standing brief lives in the loop's task file's
 * `## Spec`; this trigger just points the run at it and states how the run ends
 * (report, or `finish` for a closed loop). A closed loop injects its setpoint as a
 * `Goal (finish line): <goal>` line — prompt-injected so it wins over the file per
 * the trust hierarchy. Minimal + neutral on purpose: batch 3 owns the polished
 * prose in skill/run/exec-trigger.md; edit the template there, not this filler.
 */
export function buildExecTask(loop: Loop): string {
  const name = loop.name || loop.id;
  const taskFile = loop.taskFile ?? "(none — this loop has no task file yet; create one to hold its Spec)";
  const goalLine = loop.goal ? `Goal (finish line): ${loop.goal}` : "";
  return fillVars(loadPrompt("exec-trigger"), { name, taskFile, goalLine });
}

/** Fixed internal prompt for the data-grounded evolution pass. */
export function buildEvolvePrompt(): string {
  return loadPrompt("evolve");
}

/** Standing prompt for an owner-requested edit pass (apply one change, then stop). */
export function buildEditPrompt(): string {
  return loadPrompt("edit");
}

/** The edit payload: the loop's current envelope + the owner's instruction. The
 *  current ui/schema/workflow are inlined when present so an edit can make a
 *  surgical change to them rather than blind-rewrite (mirrors the evolve task). */
export function buildEditTask(loop: Loop, instruction: string): string {
  const where = loop.timezone ? `${loop.cron} (${loop.timezone})` : `${loop.cron} (server-local)`;
  const parts = [
    `[loop edit · ${loop.name || loop.id}]`,
    `Loop id: ${loop.id}`,
    `Current schedule: ${where}`,
    `Task file: ${loop.taskFile ?? "(none yet)"}`,
  ];
  if (loop.stateSchema?.length) {
    parts.push("Current metric schema: " + formatSchemaFields(loop.stateSchema));
  }
  if (loop.ui) parts.push("Current ui:\n```html\n" + loop.ui + "\n```");
  if (loop.workflow) parts.push("Current workflow:\n```js\n" + loop.workflow + "\n```");
  parts.push(
    `The owner wants this change:\n${instruction.trim()}`,
    "Apply it now per your instructions, then report a one-line summary of what you changed.",
  );
  return parts.join("\n\n");
}

/** The evolution payload: current loop shape + recent observed runs. */
export function buildEvolveTask(loop: Loop, runs: Run[]): string {
  const schema = loop.stateSchema?.length ? formatSchemaFields(loop.stateSchema) : "(none declared)";
  // Per-run metadata: what it reported, plus the `session` id that lets the agent
  // pull that run's FULL on-disk transcript on demand (richer than anything we
  // could inline) — see the standing evolve instructions.
  const recent = runs.map((r) => ({
    ts: r.ts,
    outcome: r.outcome,
    status: r.status,
    sample: r.sample,
    state: r.state,
    message: r.message,
    session: r.sessionId ?? null,
  }));
  return [
    `[loop evolution · ${loop.name || loop.id}]`,
    `Task file: ${loop.taskFile ?? "(none)"}`,
    `Metric schema: ${schema}`,
    "Current ui:\n" + (loop.ui ? "```html\n" + loop.ui + "\n```" : "(none yet — author one if the data warrants it)"),
    "Current workflow:\n" + (loop.workflow ? "```js\n" + loop.workflow + "\n```" : "(none)"),
    "Recent runs (oldest first):\n```json\n" + JSON.stringify(recent, null, 2) + "\n```",
    "Evolve this loop per your instructions: review the recent runs' log to sharpen the task (its brief) and distil/refine the workflow, fitting the dashboard as the lighter lever. Do not message the user.",
  ].join("\n\n");
}
