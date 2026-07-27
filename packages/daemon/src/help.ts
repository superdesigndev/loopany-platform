/**
 * `loopany --help` / `-h` / `help` — the usage screen, and `loopany -v` /
 * `--version` — the bare version line. Kept in its own module so both paths load
 * nothing heavy (no daemon/network), and so the verb list has a single readable
 * source. The usage screen leads with the daemon version (a troubleshooting
 * affordance, reusing `daemonVersion()`); when the version is unreadable it
 * degrades to the plain header instead of throwing. Grouped setup-vs-management;
 * the in-run callbacks (`loopany report …`, which the agent invokes via the PATH
 * wrapper) are NOT user commands and are deliberately omitted.
 *
 * The owner loop verbs (loops/edit/log/new) and the in-run callbacks are no longer
 * two separate mechanisms: both funnel through the one shared CLI client that POSTs to
 * the unified `/api/machine/cli` dispatch (see `cli-client.ts`) — only the LOCAL verbs
 * grouped below (up/down/update/skill/status) run without touching the server.
 */
import { daemonVersion } from "./version.js";

const HELP_BODY = ` tracks your work as a task tree and
runs the recurring parts on this machine with your own coding agent. Every task
is a folder (README + artifacts); a task with cron set is a loop.

Usage: loopany <command> [options]

  loopany                 HOME: this machine's live loops + recent runs.

Machinery
  up [--foreground]       Connect this machine / ensure its daemon is running
                          (idempotent; refreshes the loopany skill, the SessionStart
                          hook, and the \`loopany\` PATH shim). --foreground runs the
                          poll loop attached in this terminal instead of detached.
  down                    Stop the detached daemon this machine started with up.
  status                  Is this machine's daemon running? Show pid + connection.
  update                  Update this machine's daemon to the version you invoked
                          (run via npx @crewlet/loopany@latest update).
  skill [status|install]  Manage the loopany agent skill install (user scope by
    [--project]           default; --project installs into the current directory).
  setup hooks [--remove]  Install/refresh the SessionStart hook that lands the home
                          view as ambient context each session.

Read
  list [<id|slug>]        The tree (no filters, depth 2) or a filtered
    [--status S] [--priority Px] [--due] [--recurring]
    [--tree|--flat] [--depth N] [--here] [--team <id>]  worklist with breadcrumb paths.
                          Team-wide by default; --here = this machine only.
  get <id|slug>           One task in full + its children. --checkout writes a
    [--runs [--limit N] [--transcript]] [--json] [--log] [--checkout]
                          local working copy (<slug>.md + .base) for doc edits.
  search <keywords>       Full-text search — dedup BEFORE creating.
  note <ref> "<text>"     Append an immutable comment event to a task — from any
                          machine; the record the Timeline renders from.
  team                    Who can work here: teammates (humans) + registered
                          agents (machine × runtime) with presence — the roster
                          assignee= accepts. \`team rename <agent> "<name>"\`.
  log [<loop>]            A loop's recent runs (status + metrics + session id;
    [--transcript]        --transcript/--full adds the transcript). Defaults to
                          the loop for the current directory (--json, --limit N).

Write
  create "<title>"        Start a task in the cloud (no local files — artifacts
    [--cron "0 9 * * *"]  land in <root>/<slug>/ when a run writes them).
    [--parent <slug>] [--type goal|strategy|experiment|task|idea]
    [--priority P0-P3] [--status idea|todo] [--spec "…"|--spec-file <p>]
    [--assignee <email>] [--json '<envelope>'] [--dry-run] [--force]
                          Idempotent on slug. --cron makes it a LOOP;
                          without it, an inert task.
  update <id> [k=v …]     Change fields: work-state (status/priority/parent/
    [--note "<line>"]     follow_up_date/…) edits the README; envelope keys
    [--dry-run]           (cron/tz/notify/goal/enabled/…) go to the server.
                          cron="0 9 * * 1" arms the schedule; cron=null stops it.
                          assignee=<email> sets the responsible person;
                          assignee=<agent> hands the task to a registered agent
                          (\`loopany team\` lists them; auto-dispatches at status todo).
                          --note appends a dated, attributed Timeline line.
  run <id> [--wait]       Dispatch an agent at this task NOW (any task).

Tasks are never deleted: \`update <id> status=archived\` is the terminal state.
Older spellings (new, edit, show, loops, mv) still work as silent aliases.

  -h, --help              Show this help.
  -v, --version           Print the daemon version and exit.
`;

/**
 * Concise per-verb usage, printed by `loopany <verb> --help` / `-h`. Kept terse on
 * purpose (the full screen above is one `--help` away): the load-bearing property is that
 * `<verb> --help` short-circuits to THIS text with NO side effect — critical for the
 * foot-gun verbs (`update` hands the daemon over immediately, `down` stops it). Every
 * command verb the router knows (`route.ts` COMMAND_VERBS) has an entry; a missing entry
 * degrades to the full usage screen rather than throwing.
 */
const VERB_USAGE: Record<string, string> = {
  review: `loopany review [--json]
  The cross-loop worklist: artifacts runs flagged \`status: needs-review\`,
  minus what you've marked reviewed.
  loopany review clear <task> <path>   marks one handled (re-surfaces if the
  file's content changes later).`,
  up: "loopany up [--foreground]\n  Connect this machine / ensure its daemon is running (idempotent; refreshes the\n  loopany skill, the SessionStart hook, and the PATH shim). --foreground runs the\n  poll loop attached in this terminal instead of detached.",
  skill: "loopany skill [status|install] [--project]\n  Manage the loopany agent skill install (user scope by default; --project installs\n  into the current directory).",
  setup: "loopany setup hooks [--remove]\n  Install/refresh (or --remove) the SessionStart hook that lands the home view as\n  ambient context each session.",
  update: "loopany update            (daemon self-update; `loopany update <id> …` updates a TASK)\n  Hand this machine's daemon over to the (newer) CLI you invoked: stop the running\n  daemon, start the new one, refresh the skill/hook/shim.\n\nloopany update <id|slug> [key=value …] [--note \"<timeline line>\"] [--dry-run]\n  Change a task's fields: work-state (status/priority/parent/follow_up_date/…) edits\n  the README; envelope keys (cron/tz/notify/goal/enabled/…) go to the server.\n  cron=\"0 9 * * 1\" arms a schedule; cron=null stops it. assignee=<email> sets the\n  responsible person; assignee=<agent> re-binds the task to a registered agent\n  (`loopany team` lists them; <machine>/<runtime> also accepted) and auto-dispatches\n  once when it sits at status todo. --note appends a dated, attributed Timeline line.\n  --doc-file <path> pushes a doc working copy back (from `get --checkout`; sent alone,\n  guarded by the checkout's base hash — a conflict returns the server diff).",
  status: "loopany status\n  Report whether this machine's daemon is running (local pid) + its connection state.",
  down: "loopany down\n  Stop the detached daemon this machine started with `up`.",
  log: "loopany log [<loop>] [--transcript|--full] [--json] [--limit N]\n  Show a loop's recent runs (concise: status + metrics + session id). Defaults to the\n  loop for the current directory.",
  // Canonical task-object verbs.
  create:
    'loopany create "<title>" [--cron "0 9 * * *"] [--parent <slug>] [--type goal|strategy|experiment|task|idea] [--priority P0-P3] [--status idea|todo] [--assignee <email>] [--spec "…"|--spec-file <p>] [--json \'<envelope>\'] [--dry-run] [--force]\n  Start a task in the cloud (no local files; artifacts land in <root>/<slug>/ when a\n  run writes them). Idempotent on slug. --cron makes it a LOOP (runs on a schedule); without it, an inert task.\n  --assignee records the responsible PERSON; handing it to an agent is a\n  post-create step: loopany update <slug> assignee=<agent> (see `loopany team`).',
  get: "loopany get <id|slug> [--runs [--limit N] [--transcript]] [--json] [--log] [--checkout]\n  One task in full + its immediate children. --checkout writes <slug>.md + a .base\n  sidecar (the doc working copy); push edits back with update --doc-file.",
  list: "loopany list [<id|slug>] [--status S] [--priority Px] [--due] [--recurring] [--tree|--flat] [--depth N] [--here] [--team <id>]\n  The tree (no filters, depth 2) or a filtered worklist with breadcrumb paths.",
  search: "loopany search <keywords>\n  Full-text search over titles + task files — dedup BEFORE creating.",
  run: "loopany run <id|slug> [--wait]\n  Dispatch an agent at this task NOW (any task; --wait polls until the run ends).",
  mv: "loopany mv <id|slug> --before <sib> | --after <sib> | --top | --bottom | --priority Px\n  Reorder within the (parent, priority) band.",
  "agent-context": "loopany agent-context\n  Machine-readable verbs/fields/enums (JSON) for agent consumption.",
  daemon: "loopany daemon up|down|status|update\n  Grouped spellings of the machinery verbs (same behavior).",
  // Hidden aliases — kept working forever, absent from the main help screen.
  new: 'loopany new --json \'<config>\' [--dry-run]\n  Alias of `create` — prefer: loopany create "<title>" --cron "…" [--json \'<envelope>\'].',
  edit: "loopany edit <id> --json '<obj>' [--dry-run] [--workflow-file|--ui-file|--schema-file <path>]\n  Alias of `update` — prefer: loopany update <id> key=value … (same envelope keys).",
  show: "loopany show [<id>] [--full] [--json]\n  Alias of `get` — shows a loop's full editable config + recent state.",
  loops: "loopany loops [--fields a,b] [--json]\n  Alias of `list --recurring` — lists the scheduled loops.",
  // Run-only verbs (rejected outside a run).
  note: 'loopany note <ref> "<text>"\n  Append one immutable comment event to a task (any of your machines; team-scoped).\n  In a run, `loopany note "<text>"` notes the run\'s own task.',
  team: 'loopany team [--json]\n  The roster: teammates (humans, `assignee: <email>` in the README) + registered\n  agents (machine × runtime, `update <id> assignee=<agent>`) with presence.\n  `loopany team rename <agent> "<name>"` relabels an agent (its slug stays stable).',
  report: "loopany report ...\n  In-run only: the run's terminal record (status + message + metrics). Outside a run this is rejected.",
  done: "loopany done ...\n  In-run only alias of `report`. Outside a run this is rejected.",
  finish: "loopany finish ...\n  In-run only: the running agent marks a closed loop's goal met. Outside a run this is rejected.",
  complete: "loopany complete ...\n  In-run only alias of `finish`. Outside a run this is rejected.",
};

/** `loopany <version>` for humans, or a plain fallback when it's unreadable. */
function versionLabel(version: string | undefined): string {
  return version ? `loopany v${version}` : "loopany";
}

/**
 * `loopany <verb> --help` / `-h`: print that verb's concise usage and exit 0, running NO
 * handler side effect. Unknown verbs fall back to the full usage screen.
 */
export function printVerbHelp(
  verb: string,
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  const usage = VERB_USAGE[verb];
  if (!usage) return printHelp(out, version);
  out(`${versionLabel(version)}\n\n${usage}\n\nRun \`loopany --help\` for all commands.\n`);
  return 0;
}

export function printHelp(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${versionLabel(version)} - the Loopany daemon:${HELP_BODY}`);
  return 0;
}

/** `loopany -v` / `--version`: just the version line, never starts the daemon. */
export function printVersion(
  out: (s: string) => void = (s) => process.stdout.write(s),
  version: string | undefined = daemonVersion(),
): number {
  out(`${version ? `loopany v${version}` : "loopany (version unknown)"}\n`);
  return 0;
}
