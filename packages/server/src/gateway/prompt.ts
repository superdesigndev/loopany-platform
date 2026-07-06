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
 *
 * Batch 2 extends the same move to the EVOLVE and EDIT runs, and trims the inlined
 * run history. `buildEvolvePrompt`/`buildEditPrompt` now return "" (empty system
 * prompt, exactly like exec) — the standing prose ships in the first user turn,
 * concatenated ahead of each role's payload by `buildEvolveTask`/`buildEditTask`.
 * The untrusted-data guard rides along in that prose (evolve reads run messages;
 * edit reads the loop's current config — both untrusted). `buildEvolveTask` no
 * longer dumps up to 12 runs as pretty-printed JSON (tens of KB of full messages +
 * full state); it emits a compact one-line-per-run SURVEY (ts / role / outcome-status
 * / cost / state KEYS only / session id / message clipped ~100 chars), headed by the
 * on-demand pointers (`loopany log [--transcript]`, now reachable in-run, and the
 * local session JSONL). `buildEditTask` KEEPS its inlined current ui/workflow/schema:
 * that is current config, not history, and is genuinely useful for a surgical edit.
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
    : `loopany report --status new
  # this loop has no metric schema, so this run records no chart metrics — just the status/message.
  # to start charting a trend, an evolve/edit pass can define a metric schema first.`;
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

/**
 * The evolve system prompt is now EMPTY (like exec, Batch 1): the standing evolve
 * prose moved into the first user turn, concatenated ahead of the payload by
 * `buildEvolveTask`. Returning "" makes the daemon's `--append-system-prompt-file`
 * a harmless no-op on every existing daemon (ships server-first). Kept as a function
 * so delivery wiring stays stable; retire once the daemon drops the flag.
 */
export function buildEvolvePrompt(): string {
  return "";
}

/**
 * The edit system prompt is now EMPTY (like exec/evolve, Batch 2): the short edit
 * CORE moved into the first user turn, concatenated ahead of the payload by
 * `buildEditTask`. Same server-first, harmless-no-op rationale as the others.
 */
export function buildEditPrompt(): string {
  return "";
}

/** The edit user turn — the short edit CORE (apply ONE owner-requested change, don't
 *  run the task, don't finish, end with `loopany report`; carries the untrusted-data
 *  guard + skill pointer) ahead of the payload. The current ui/schema/workflow are
 *  inlined when present so an edit can make a surgical change to them rather than
 *  blind-rewrite — that is current CONFIG, not history, so it stays inlined (§3.4). */
export function buildEditTask(loop: Loop, instruction: string): string {
  const where = loop.timezone ? `${loop.cron} (${loop.timezone})` : `${loop.cron} (server-local)`;
  const parts = [
    loadPrompt("edit"),
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
    "Apply it now per the instructions above, then report a one-line summary of what you changed.",
  );
  return parts.join("\n\n");
}

/** How many chars of a run's message survive in the compact survey (rest → ellipsis;
 *  the full text is a `loopany log`/session away). */
const SURVEY_MESSAGE_CAP = 100;

/** A run's message collapsed to a single clipped line for the survey. */
function surveyMessage(message: string | null): string {
  const s = (message ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "—";
  return s.length > SURVEY_MESSAGE_CAP ? s.slice(0, SURVEY_MESSAGE_CAP) + "…" : s;
}

/** One run as a single survey line. State appears as KEYS only — values are noise at
 *  survey altitude, and the agent pulls them via `loopany log`/the session if a call
 *  hinges on them. The session id is kept in FULL so the deep-dive `find … -name
 *  '<session>.jsonl'` resolves; only the message is clipped. */
function surveyRow(r: Run): string {
  const outcomeStatus = `${r.outcome ?? "—"}/${r.status ?? "—"}`;
  const cost = r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "—";
  const keys = r.state && typeof r.state === "object" ? Object.keys(r.state) : [];
  const metrics = keys.length ? keys.join(",") : "—";
  return [
    (r.ts ?? "—").padEnd(24),
    (r.role ?? "—").padEnd(7),
    outcomeStatus.padEnd(16),
    cost.padEnd(7),
    metrics.padEnd(16),
    (r.sessionId ?? "—").padEnd(38),
    surveyMessage(r.message),
  ].join(" ");
}

/** The compact recent-runs survey: one line per run (oldest → newest), headed by the
 *  on-demand pointers. Replaces the old tens-of-KB pretty-printed JSON dump — full
 *  detail (state values, un-clipped message, transcript) is a `loopany log`/session
 *  away, and `loopany log` now works IN-RUN too, so this is enrichment, not the only
 *  window into history. */
function renderRecentRuns(runs: Run[]): string {
  const header =
    `Recent runs (oldest → newest, N=${runs.length}) — a compact survey. Full detail on demand:\n` +
    `  · loopany log [--transcript]  — the same survey straight from the server (works in-run); --transcript adds each run's clipped transcript\n` +
    `  · session JSONL — take a run's session id below, then: find ~/.claude/projects -name '<session>.jsonl'  (the deep, unclipped dive)`;
  if (!runs.length) return `${header}\n\n(no prior runs yet)`;
  const columns = [
    "ts".padEnd(24),
    "role".padEnd(7),
    "outcome/status".padEnd(16),
    "cost".padEnd(7),
    "metrics(keys)".padEnd(16),
    "session".padEnd(38),
    "message",
  ].join(" ");
  return [header, "", columns, ...runs.map(surveyRow)].join("\n");
}

/** The evolution user turn — the standing evolve prose (shared with the installable
 *  skill, so run-dispatch and the skill can't drift) ahead of the payload: current
 *  loop shape + the compact recent-runs survey. */
export function buildEvolveTask(loop: Loop, runs: Run[]): string {
  const schema = loop.stateSchema?.length ? formatSchemaFields(loop.stateSchema) : "(none declared)";
  return [
    loadPrompt("evolve"),
    `[loop evolution · ${loop.name || loop.id}]`,
    `Task file: ${loop.taskFile ?? "(none)"}`,
    `Metric schema: ${schema}`,
    "Current ui:\n" + (loop.ui ? "```html\n" + loop.ui + "\n```" : "(none yet — author one if the data warrants it)"),
    "Current workflow:\n" + (loop.workflow ? "```js\n" + loop.workflow + "\n```" : "(none)"),
    renderRecentRuns(runs),
    "Evolve this loop per your instructions: review the recent runs' log to sharpen the task (its brief) and distil/refine the workflow, fitting the dashboard as the lighter lever. Do not message the user.",
  ].join("\n\n");
}
