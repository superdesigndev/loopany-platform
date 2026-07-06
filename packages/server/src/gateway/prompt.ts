/**
 * Builds the per-run prompts on the SERVER, to ship inside a delivery (the machine
 * just writes the prompt to a file and runs claude with it). Ported from c0's
 * loop-prompt.ts, bound to the new Loop row and the renamed `loopany` CLI. Prompt
 * prose lives as markdown loaded + `{{token}}`-filled here. ALL prompt prose lives
 * under src/skill/: the public authoring trio (create/update/evolve) in
 * skill/references/, and the INTERNAL run prompts (exec-core, edit) in skill/run/ —
 * server-side run-dispatch only, never served or bundled. The `evolve` text is the
 * SINGLE source of truth shared with the installable agent skill
 * (skill/references/evolve.md) — run-dispatch and the skill read the same file, so
 * the evolution guidance can't drift. `edit` is a run-token verb prompt with no
 * authoring twin (see skill/references/update.md for the authoring CLI).
 *
 * Run-experience redesign, Batch 1: the exec run's instructions now live entirely
 * in the FIRST USER TURN (`buildExecTask` ← exec-core.md), not the system prompt.
 * `buildLoopSystemPrompt` returns "" — the daemon still writes it to the sys file
 * and passes `--append-system-prompt-file`, but an empty file is a harmless no-op
 * on every existing daemon (so this ships server-first, no daemon change). exec-core
 * is the self-sufficient CORE (identity + untrusted-data guard + the non-negotiable
 * fallback core + per-run trigger + a pointer to the installable loopany skill for
 * the deep protocol); the deep protocol itself moves to the skill in a later batch.
 * The old standing system prompt (exec-loop.md) is retained as that batch's source
 * but is no longer imported or delivered.
 */
import type { Loop, Run, StateField } from "../db/schema.js";

// Inlined at build time (Vite ?raw) so the prompt prose ships inside the nitro
// bundle. Reading them from disk at runtime broke in prod: nitro bundles JS only,
// so the `*.md` source files don't exist under .output and poll() threw ENOENT.
// `?raw` resolves identically from skill/run/ as it did from scheduler/prompts/.
import execCore from "../skill/run/exec-core.md?raw";
import evolve from "../skill/references/evolve.md?raw";
import edit from "../skill/run/edit.md?raw";

const PROMPTS: Record<string, string> = {
  "exec-core": execCore,
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

/** The schema-derived `loopany report` grammar line for a loop's metric charts. */
function stateReportLine(loop: Loop): string {
  const schema = loop.stateSchema ?? [];
  return schema.length
    ? `loopany report --status <s> --state '{${schema.map((f) => `"${f.key}":<n>`).join(",")}}'
  # record this run's metrics for the trend chart. Fields (keys must match, values must be finite numbers):
  #   ${formatSchemaFields(schema)}
  # report a subset if you only observed some; big payloads: --state-file <path>.`
    : `loopany report --status new --sample <number>     # optional single metric for charts`;
}

/**
 * The standing system prompt is now EMPTY: the exec run's instructions moved into
 * the first user turn (`buildExecTask`, see the run-experience redesign / Batch 1).
 * The daemon still writes this to the sys file and passes `--append-system-prompt-file`,
 * so returning "" makes that flag a harmless no-op on every existing daemon — the
 * prompt move ships server-first with no daemon change (design §5.2). Kept as a
 * function so callers/wiring stay stable; retire once the daemon drops the flag.
 */
export function buildLoopSystemPrompt(_loop: Loop): string {
  return "";
}

/**
 * The per-run user turn — now the FULL exec CORE (identity, untrusted-data guard,
 * the non-negotiable inline fallback core, the report/finish grammar, the per-run
 * trigger, and a pointer to the installable loopany skill for the deep protocol).
 * Self-sufficient by design: the skill is enrichment, never a dependency (§3.1). A
 * closed loop injects its setpoint as a `Goal (finish line): <goal>` line —
 * prompt-injected so it wins over the file per the trust hierarchy; an open loop
 * leaves that line blank. `{{stateLine}}` carries the schema-derived report grammar.
 */
export function buildExecTask(loop: Loop): string {
  const name = loop.name || loop.id;
  const taskFile = loop.taskFile ?? "(none — this loop has no task file yet; create one to hold its Spec)";
  const goalLine = loop.goal ? `Goal (finish line): ${loop.goal}` : "";
  const stateLine = stateReportLine(loop);
  return fillVars(loadPrompt("exec-core"), { name, taskFile, goalLine, stateLine });
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
    // What the run cost (claude's own USD estimate) — evolve-relevant evidence:
    // a consistently expensive loop is a signal to lift deterministic work into
    // the workflow or sharpen the Spec so runs stop wandering.
    costUsd: r.costUsd ?? null,
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
