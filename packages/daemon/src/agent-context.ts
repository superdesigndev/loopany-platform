/**
 * `loopany agent-context` — the machine-readable middle layer of the CLI's
 * introspection (human `--help` → this → the skill docs). Static + versioned
 * with the binary, so it is offline-correct and never drifts from the verbs
 * this CLI actually ships. Agents parse this instead of scraping help prose.
 */
import { createRequire } from "node:module";

import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from "./taskfile.js";

function cliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export function runAgentContext(out: (s: string) => void = (s) => process.stdout.write(s)): number {
  const ctx = {
    schemaVersion: 1,
    cli: "loopany",
    cliVersion: cliVersion(),
    object: "task",
    model:
      "Every task is a folder (<root>/<slug>/README.md + artifacts beside it). A loop is a task with cron set. " +
      "Work-state lives ONLY in README front matter (the file is the source of truth); the execution envelope lives on the server. " +
      "Hierarchy comes from the parent: field (slug reference) — folders stay flat.",
    verbs: {
      create: {
        usage: 'loopany create "<title>" [--parent <slug>] [--type T] [--priority Px] [--status idea|todo] [--body S] [--slug S] [--json <envelope>] [--dry-run] [--force]',
        notes: "Idempotent on slug. Fuzzy-duplicate titles warn unless --force. Scaffolds the folder locally, then registers it.",
      },
      get: { usage: "loopany get <id|slug> [--runs [--limit N] [--transcript]] [--json]", notes: "One node in full + immediate children rows." },
      list: {
        usage: "loopany list [<id|slug>] [--status S] [--priority Px] [--due] [--recurring] [--tree|--flat] [--depth N] [--json]",
        notes: "No filters → tree (depth 2). Any filter → flat worklist with breadcrumb paths. --due = follow-up nodes whose follow_up_date arrived.",
      },
      search: { usage: "loopany search <keywords> [--json]", notes: "Full-text over titles + README content. Run before create (dedup)." },
      update: {
        usage: 'loopany update <id|slug> [key=value …] [--note "<line>"] [--workflow-file F] [--ui-file F] [--schema-file F] [--dry-run] [--json]',
        notes:
          "Work-state keys edit the README front matter; envelope keys PATCH the server. cron=<expr> arms the schedule; cron=null disarms. " +
          "--note appends a dated ## Timeline line.",
      },
      mv: { usage: "loopany mv <id|slug> --before <sib> | --after <sib> | --top | --bottom | --priority Px", notes: "Reorders within the (parent, priority) band via fractional order." },
      run: { usage: "loopany run <id|slug> [--wait] [--json]", notes: "One-shot dispatch now (any task, cron or not). --wait blocks for the outcome (≤10min)." },
      "daemon up|down|status|update": { usage: "loopany daemon <up|down|status|update>", notes: "Machine daemon lifecycle." },
      skill: { usage: "loopany skill [status|install] [--project]", notes: "Agent-skill install management." },
    },
    fields: {
      workState: {
        title: "string",
        type: TASK_TYPES,
        status: TASK_STATUSES,
        priority: TASK_PRIORITIES,
        owner: "email",
        parent: "slug of the parent task",
        refs: "comma-separated slugs",
        follow_up_date: "YYYY-MM-DD (REQUIRED when status=follow-up)",
        order: "number (managed by mv — don't hand-set)",
      },
      envelope: {
        cron: "5-field cron or null (null = inert task)",
        timezone: "IANA tz",
        notify: ["always", "auto", "never"],
        goal: "one-line finish condition (non-null ⇒ self-finishes when met)",
        model: "string",
        enabled: "boolean",
        name: "string",
        runAt: "30m|2h|1d or future ISO (one-shot)",
      },
    },
    invariants: [
      "status=follow-up requires follow_up_date (hard error).",
      "status=done|archived pauses a recurring task's schedule (enabled=false).",
      "Tasks are never deleted — status=archived is the terminal state.",
      "One cron per task; two cadences = two child tasks.",
      "order is never hand-set; use mv.",
    ],
    deprecatedAliases: {
      new: "create",
      edit: "update",
      loops: "list --recurring --flat",
      log: "get <id> --runs",
      "up/down/status": "daemon up/down/status",
    },
  };
  out(`${JSON.stringify(ctx, null, 2)}\n`);
  return 0;
}
