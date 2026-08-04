/**
 * PER-VERB HELP AND THE FLAG SETS, single-sourced (CLI spec §9).
 *
 * One table serves three consumers, which is what keeps them from drifting:
 *   1. `<verb> --help` — answered locally, no round trip, before any side effect;
 *   2. the `allowed[N]:` line on an unknown-flag refusal (§5.7);
 *   3. the local grammar check that decides whether a flag reaches the server.
 *
 * `see also:` carries the closed front-matter key set on purpose: it makes the
 * artifact contract discoverable without an agent having to trigger a refusal to
 * learn it. Help text is IDENTICAL for every caller — with per-run tokens gone
 * there are no per-verb caps, so no verb's help says "not available to your role".
 */

export interface VerbSpec {
  usage: string;
  /** `[flag-with-argument, one-line meaning]`. The first token is the flag name. */
  flags: [string, string][];
  examples: string[];
  /** Guards that are about COMBINATIONS, so they are invisible in a flag list. */
  notes?: string[];
  seeAlso?: string;
}

const TASK_KEYS = "task front matter: title, key, follow_up, watcher, needs_human, payload";
const DOC_KEYS = "doc front matter: title, key, format, payload";
const LOOP_KEYS = "loop front matter: title, key, cron, workdir, payload — body is the charter";

export const VERBS: Record<string, VerbSpec> = {
  "task list": {
    usage: "loopany task list [flags]",
    flags: [
      ["--open", "status = open (the default when no status flag is given)"],
      ["--closed", "status = closed"],
      ["--due", "follow_up_at <= now — a query-time predicate, self-healing"],
      ["--unwatched", "watcher is empty — the unclaimed pool"],
      ["--watcher <loop-id>", "tasks that loop owes; an explicit id, there is no `self`"],
      ["--creator <loop-id>", "tasks that loop made — the created_by_loop provenance stamp"],
      ["--since <duration>", "bare, unsigned lookback (14d); meaningful with --closed"],
    ],
    examples: [
      "loopany task list --open --unwatched",
      "loopany task list --watcher loop-4c1d77 --due",
      "loopany task list --creator loop-8e3311 --closed --since 14d",
    ],
    notes: [
      "predicates compose as AND; loops are excluded structurally and no flag brings them back",
      "reads are not ownership-checked — --watcher and --creator may name any loop in the team",
    ],
    seeAlso: TASK_KEYS,
  },
  "task show": {
    usage: "loopany task show <id> [flags]",
    flags: [["--file", "emit the canonical artifact file instead of the TOON view"], ["--full", "do not truncate the body"]],
    examples: ["loopany task show task-7f3a91", "loopany task show task-7f3a91 --file > t.md"],
    notes: ["--file output is a valid input file: read it, edit it, then `task update <id> --file`"],
    seeAlso: TASK_KEYS,
  },
  "task create": {
    usage: "loopany task create --file <path> [flags]",
    flags: [
      ["--file <path>", "the artifact file IS the object; `-` reads stdin"],
      ["--needs-human <text>", "attach a question; the task enters the human inbox"],
      ["--watcher <loop-id>", "the loop that acts next, and the loop a human answer wakes"],
      ["--follow-up <date>", "RFC 3339 with offset, or relative (+3d, +12h)"],
    ],
    examples: [
      "loopany task create --file observe-pr-201.md",
      'loopany task create --file reddit-reply-a.md --needs-human "Post this reply?" --watcher loop-8e3311',
    ],
    notes: [
      "a flag and a front-matter key supplying the same field is refused, never overridden",
      "title, key and payload have no flags — they belong in the file so a retry replays byte-identically",
    ],
    seeAlso: TASK_KEYS,
  },
  "task update": {
    usage: "loopany task update <id> [flags]",
    flags: [
      ["--follow-up <date>", "RFC 3339 with offset, or relative (+3d, +12h); `null` clears"],
      ["--watcher <loop-id>", "the loop that acts next (e.g. loop-4c1d77); `null` releases to the pool"],
      ["--needs-human <text>", "attach a question; the task enters the human inbox"],
      ["--payload-merge <json>", "one JSON object, shallow top-level merge; a `null` value deletes a key"],
      ["--file <path>", "replace front matter + body from an artifact file; `-` reads stdin"],
    ],
    examples: [
      "loopany task update task-7f3a91 --watcher loop-4c1d77 --follow-up +3d",
      'loopany task update task-7f3a91 --needs-human "error rate doubled — (a) revert (b) one more day"',
      "loopany task update task-7f3a91 --payload-merge '{\"merged_at\":\"2026-08-02T11:31:00+08:00\"}'",
    ],
    notes: [
      "a flag and a front-matter key supplying the same field is refused, never overridden",
      "only a human clears a pending question — a run may attach one, never empty or replace one",
    ],
    seeAlso: TASK_KEYS,
  },
  "task close": {
    usage: "loopany task close <id> --note <text>",
    flags: [["--note <text>", "the closing event's attestation; required, one sentence is enough"]],
    examples: ['loopany task close task-7f3a91 --note "error rate back to baseline; no action needed"'],
    notes: [
      "close is refused while a question is waiting for a human — attestation, not a status flip",
      "closing before follow_up is legal: the date is a resurface schedule, not an obligation",
    ],
  },
  "doc show": {
    usage: "loopany doc show <id> [flags]",
    flags: [["--file", "emit the canonical artifact file instead of the TOON view"], ["--full", "do not truncate the body"]],
    examples: ["loopany doc show doc-2b8e04", "loopany doc show doc-2b8e04 --file > d.md"],
    seeAlso: DOC_KEYS,
  },
  "doc create": {
    usage: "loopany doc create --file <path>",
    flags: [["--file <path>", "the artifact file IS the object; `-` reads stdin"]],
    examples: ["loopany doc create --file weekly-summary.md"],
    notes: [
      "register a product as soon as it exists — partial products survive a dead run",
      "not for the run report: `finish` turns the run's own output into a doc row",
    ],
    seeAlso: DOC_KEYS,
  },
  "doc update": {
    usage: "loopany doc update <id> --file <path>",
    flags: [["--file <path>", "the replacement artifact: front matter + body; `-` reads stdin"]],
    examples: ["loopany doc show doc-2b8e04 --file > d.md", "loopany doc update doc-2b8e04 --file d.md"],
    notes: [
      "--file is the only input: a doc has no field the kernel acts on, so content is edited as a file",
      "run reports are immutable BY CONVENTION — the kernel accepts the write and says so",
    ],
    seeAlso: DOC_KEYS,
  },
  "loop create": {
    usage: "loopany loop create --file <path>",
    flags: [["--file <path>", "the artifact file IS the loop: front matter + the charter body; `-` reads stdin"]],
    examples: ["loopany loop create --file housekeeper.md"],
    notes: [
      "a HUMAN verb: creating a loop mints a standing cadence and a new actor, which is governance",
      "a run proposes one instead: `task create --needs-human \"create a loop that …\" --watcher <its own id>`",
      "`cron:` arms the loop at birth — next_fire is the first occurrence after now; omit it for an on-demand loop",
      "`workdir:` BINDS a directory (absolute path): every run of this loop executes there",
      "no MACHINE is bound — any machine of the team claims, and one that lacks the workdir fails the run loudly rather than running somewhere else",
    ],
    seeAlso: LOOP_KEYS,
  },
  "loop list": {
    usage: "loopany loop list [--status <state>]",
    flags: [["--status <state>", "active | paused | retired; absent shows the whole roster"]],
    examples: ["loopany loop list", "loopany loop list --status active", "loopany loop list --status retired"],
    notes: [
      "a loop has THREE states, so status takes a value — there is no two-flag form that spans them",
      "the default is every loop including retired ones: a team's roster is small, and history is the point",
    ],
  },
  "loop show": {
    usage: "loopany loop show <loop-id> [flags]",
    flags: [["--file", "emit the canonical loop artifact instead of the TOON view"], ["--full", "do not truncate the charter"]],
    examples: ["loopany loop show loop-8e3311", "loopany loop show loop-8e3311 --file > charter.md"],
    notes: ["--file output is a valid input file: read it, edit the charter, then `loop evolve <id> --file`"],
    seeAlso: LOOP_KEYS,
  },
  "loop evolve": {
    usage: "loopany loop evolve <loop-id> --file <path>",
    flags: [["--file <path>", "the full replacement charter; the server computes the diff"]],
    examples: ["loopany loop evolve loop-8e3311 --file charter.md"],
    notes: [
      "the free zone: no approval key, but the server checks the loop is your run's own",
      "cadence is NOT here — it is governance, and needs a human approval key (`loop update`)",
      "a retired loop's charter is frozen: evolve is refused for good, never queued",
    ],
    seeAlso: LOOP_KEYS,
  },
  "loop pause": {
    usage: "loopany loop pause <loop-id> [--note <text>]",
    flags: [["--note <text>", "why, recorded on the event; optional, one sentence"]],
    examples: ['loopany loop pause loop-8e3311 --note "muted while the API migration lands"'],
    notes: [
      "a HUMAN verb: a run never pauses a loop, it proposes with `task create --needs-human`",
      "pausing disarms the cadence (next_fire is cleared) and no run of it is claimed until it resumes",
      "pausing an already-paused loop is a success that changed nothing — a retry is free",
    ],
  },
  "loop resume": {
    usage: "loopany loop resume <loop-id> [--note <text>]",
    flags: [["--note <text>", "why, recorded on the event; optional, one sentence"]],
    examples: ["loopany loop resume loop-8e3311"],
    notes: [
      "time never un-pauses a loop — this verb is the only exit, including from a failure auto-pause",
      "re-arms to the NEXT occurrence: a week paused owes exactly one fire, not a week of them",
      "a retired loop cannot be resumed; retirement is terminal",
    ],
  },
  "loop retire": {
    usage: "loopany loop retire <loop-id> [--note <text>]",
    flags: [["--note <text>", "why, recorded on the event; optional but strongly advised"]],
    examples: ['loopany loop retire loop-8e3311 --note "the outreach experiment is over"'],
    notes: [
      "retire IS the delete: the kernel is event-sourced, so nothing is ever erased and there is no `loop delete`",
      "terminal — the charter freezes, the cadence is gone, and there is no un-retire",
      "the loop, its runs and everything it created stay readable: `loop list --status retired`, `loop show <id>`",
    ],
  },
  "loop run-now": {
    usage: "loopany loop run-now <loop-id>",
    flags: [],
    examples: ["loopany loop run-now loop-8e3311"],
    notes: [
      "a HUMAN verb: firing a loop off its cadence is the owner's act, and a run that could wake itself is a loop with no cadence",
      "a PAUSED loop DOES fire and stays paused — pause governs the clock, not this button, so it is one run and then quiet again",
      "a RETIRED loop is refused: retirement is terminal, and the charter is frozen",
      "one queued run per loop: a second fire reports the run already queued instead of minting a twin",
      "no flags and no body — the loop already says what it does, so an off-cadence run is a button, not a form",
    ],
  },
  "loop update": {
    usage: "loopany loop update <loop-id> [--cron <expr>] [--workdir <path>] --approval <event-id>",
    flags: [
      ["--cron <expr>", "the new cadence, five fields: minute hour day-of-month month day-of-week"],
      ["--workdir <path>", "the new bound directory: absolute, and it must exist on the executing machine"],
      ["--approval <event-id>", "the verdict event id from a human's answer on a task this loop created"],
    ],
    examples: [
      'loopany loop update loop-8e3311 --cron "0 * * * *" --approval ev-9c22d1',
      "loopany loop update loop-8e3311 --workdir /Users/you/Workspace/your-repo --approval ev-9c22d1",
    ],
    notes: [
      "the TWO governed execution facets are WHEN (cron) and WHERE (workdir); either alone is legal, both ride one approval",
      "step 3 of four: propose with `task create --needs-human`, a human answers, then this, then `task close`",
      "the kernel checks the key exists, is human, and hangs on your loop's task — not that it matches the change",
      "a `cron:`/`workdir:` that differs is exactly what `loop evolve` refuses (APPROVAL_REQUIRED) — this verb is where it lands",
    ],
  },
  inbox: {
    usage: "loopany inbox",
    flags: [],
    examples: ["loopany inbox"],
    notes: ["no flags: the inbox is the safety floor, and a filter could hide an arm of it"],
  },
  answer: {
    usage: 'loopany answer <task-id> "<text>"',
    flags: [],
    examples: ['loopany answer task-7f3a91 "(b) give it one more day, check tomorrow night"'],
    notes: [
      "free text — approve, reject and instructions are all just the answer; the kernel parses nothing",
      "answering wakes the watcher loop; a task with no watcher just records the answer",
    ],
  },
};

/** The legal flag names for a verb — the `allowed[N]:` line of an unknown-flag
 *  refusal, and the local grammar check, read from the same table as the help. */
export function flagNames(command: string): string[] {
  return (VERBS[command]?.flags ?? []).map(([flag]) => flag.split(" ", 1)[0]!);
}

export function verbHelp(command: string): string {
  const spec = VERBS[command];
  if (!spec) {
    const names = Object.keys(VERBS);
    return `usage: loopany <task|doc|loop> <verb> [flags]\nverbs[${names.length}]: ${names.join(", ")}\nhelp[1]:\n  Run \`loopany task list --help\` for one verb's full grammar\n`;
  }
  const width = Math.max(0, ...spec.flags.map(([flag]) => flag.length));
  let text = `usage: ${spec.usage}\n`;
  text += spec.flags.length ? `flags:\n${spec.flags.map(([flag, meaning]) => `  ${flag.padEnd(width)}  ${meaning}`).join("\n")}\n` : "flags: none\n";
  text += `examples:\n${spec.examples.map((line) => `  ${line}`).join("\n")}\n`;
  if (spec.notes?.length) text += `notes:\n${spec.notes.map((line) => `  ${line}`).join("\n")}\n`;
  if (spec.seeAlso) text += `see also:\n  ${spec.seeAlso}\n`;
  return text;
}
