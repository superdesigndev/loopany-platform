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
  /**
   * Flags a verb used to take and now REFUSES. They are not advertised (not in
   * `--help`, not in an `allowed[N]:` line) but they are still RECOGNIZED, so
   * the verb's own plan gets to answer with the teaching the retirement needs
   * instead of a generic "unknown flag --x, did you mean --y". Retiring a flag
   * with no entry here is how a removal turns into a typo suggestion.
   */
  retired?: string[];
  examples: string[];
  /** Guards that are about COMBINATIONS, so they are invisible in a flag list. */
  notes?: string[];
  seeAlso?: string;
}

const TASK_KEYS = "task front matter: title, key, parent, follow_up, watcher, needs_human, payload, mirrors (create-only)";
const DOC_KEYS = "doc front matter: title, key, format, payload, mirrors (create-only)";
const MIRROR_LAW = "a mirror tells you WHERE to look, never WHAT state it is in";
const MIRROR_KINDS = "canonical kinds: github-pr, github-issue, url, gsc-property — free-form, kebab-cased on write; a KNOWN kind also has its coords shape checked";

/** S3 retires the kernel loop-authoring vocabulary without deleting its parser
 * yet. Every old command answers with the production equivalent instead of
 * mutating the history-only kernel twin. */
export function loopSurfacePointer(command: string, id?: string): string {
  const loopId = id ?? "<loop-id>";
  const help: Record<string, string[]> = {
    "loop list": ["Run `loopany loops` — production loops are now the only roster."],
    "loop show": [`Run \`loopany show ${loopId}\` for the production loop's full editable envelope and recent runs.`],
    "loop create": ["Create through the production flow: run `loopany new --json '<config>'`, or use the installed loopany skill for guided setup."],
    "loop evolve": [`Edit the production loop with \`loopany edit ${loopId} --json '<patch>'\`; its standing brief lives in the task file's \`## Spec\`.`],
    "loop update": [`Edit the production loop with \`loopany edit ${loopId} --json '<patch>'\`; owner edits are the schedule/config authority.`],
    "loop pause": [`Pause it with \`loopany edit ${loopId} --json '{"enabled":false}'\`.`],
    "loop resume": [`Resume it with \`loopany edit ${loopId} --json '{"enabled":true}'\`.`],
    "loop run-now": ["Use Run now on the production loop/dashboard. A paused loop fires once and stays paused."],
    "loop retire": ["Production loops pause, finish a declared goal, or are deleted by the owner; the kernel's terminal retire state no longer governs a live loop."],
  };
  const hints = help[command] ?? ["Run `loopany loops` to find the production loop surface."];
  return (
    "error: kernel loop commands moved to the production loop surface\n" +
    "code: SURFACE_MOVED\n" +
    `command: ${command}\n` +
    `help[${hints.length}]:\n${hints.map((hint) => `  ${hint}`).join("\n")}\n`
  );
}

export const VERBS: Record<string, VerbSpec> = {
  "task list": {
    usage: "loopany task list [flags]",
    flags: [
      ["--open", "status = open (the default when no status flag is given)"],
      ["--closed", "status = closed"],
      ["--due", "follow_up_at <= now — a query-time predicate, self-healing"],
      ["--watcher <loop-id>", "tasks that loop owes; an explicit id, there is no `self`"],
      ["--creator <loop-id>", "tasks that loop made — the created_by_loop provenance stamp"],
      ["--since <duration>", "bare, unsigned lookback (14d); meaningful with --closed"],
    ],
    examples: [
      "loopany task list --watcher loop-4c1d77 --due",
      "loopany task list --creator loop-8e3311 --closed --since 14d",
    ],
    notes: [
      "predicates compose as AND; loops are excluded structurally and no flag brings them back",
      "reads are not ownership-checked — --watcher and --creator may name any loop in the team",
      "there is no unwatched set to query: every task names the loop that acts next",
    ],
    seeAlso: TASK_KEYS,
  },
  "task show": {
    usage: "loopany task show <id-or-key> [flags]",
    flags: [["--file", "emit the canonical artifact file instead of the TOON view"], ["--full", "do not truncate the body"]],
    examples: ["loopany task show task-7f3a91", "loopany task show weekly-cleanup", "loopany task show task-7f3a91 --file > t.md"],
    notes: [
      "--file output is a valid input file: read it, edit it, then `task update <id> --file`",
      "the creation `key:` addresses the object too — the handle to carry across runs, since an id is fresh randomness",
    ],
    seeAlso: TASK_KEYS,
  },
  "task create": {
    usage: "loopany task create --file <path> [flags]",
    flags: [
      ["--file <path>", "the artifact file IS the object; `-` reads stdin"],
      ["--needs-human <text>", "attach a question; the task enters the human inbox"],
      ["--watcher <loop-id>", "the loop that acts next; DEFAULTS to your own loop, so pass it only to hand the task on"],
      ["--parent <task-id>", "file this under a bigger task (e.g. task-7f3a91); it keeps its own watcher and its own ending"],
      ["--follow-up <date>", "RFC 3339 with offset, or relative (+3d, +12h); its arrival WAKES the watcher"],
    ],
    examples: [
      "loopany task create --file observe-pr-201.md",
      'loopany task create --file reddit-reply-a.md --needs-human "Post this reply?" --watcher loop-8e3311',
      "loopany task create --file step-1.md --parent task-7f3a91",
    ],
    notes: [
      "a flag and a front-matter key supplying the same field is refused, never overridden",
      "title, key and payload have no flags — they belong in the file so a retry replays byte-identically",
      "a task ALWAYS has a watcher: yours by default from a run, and required outright when a human creates one",
      "a parent is a TASK, never a loop, and it never implies a watcher: the parent's follow-up wakes the PARENT's watcher only",
    ],
    seeAlso: TASK_KEYS,
  },
  "task update": {
    usage: "loopany task update <id-or-key> [flags]",
    flags: [
      ["--follow-up <date>", "RFC 3339 with offset, or relative (+3d, +12h); `null` clears"],
      ["--parent <task-id>", "move it under another task; `null` makes it a root again"],
      ["--needs-human <text>", "attach a question; the task enters the human inbox"],
      ["--payload-merge <json>", "one JSON object, shallow top-level merge; a `null` value deletes a key"],
      ["--file <path>", "replace front matter + body from an artifact file; `-` reads stdin"],
    ],
    retired: ["--watcher"],
    examples: [
      "loopany task update task-7f3a91 --follow-up +3d",
      'loopany task update task-7f3a91 --needs-human "error rate doubled — (a) revert (b) one more day"',
      "loopany task update task-7f3a91 --parent task-4c1d77",
      "loopany task update task-7f3a91 --payload-merge '{\"merged_at\":\"2026-08-02T11:31:00+08:00\"}'",
    ],
    notes: [
      "a flag and a front-matter key supplying the same field is refused, never overridden",
      "only a human clears a pending question — a run may attach one, never empty or replace one",
      "there is NO --watcher here: a task keeps the watcher it was named with at create, so close it and re-file if the wrong loop is on the hook",
      "a parent CAN be cleared (`--parent null`): a task may stop being a sub-task, and a parent inside its own subtree is refused PARENT_CYCLE",
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
  "task tell": {
    usage: 'loopany task tell <task-id> "<directive>"',
    flags: [],
    examples: [
      'loopany task tell task-7f3a91 "drop this bet — close the PR, clean up the branch, then close the task"',
      'loopany task tell task-7f3a91 "ship it, but wait for CI to go green first"',
    ],
    notes: [
      "a HUMAN verb, and the mirror image of `answer`: the inbox is the loop asking you, this is you telling the loop",
      "it queues ONE run for the watching loop with the task in scope, carrying your words VERBATIM in its work order",
      "the run executes the INTENT against reality first and the kernel's records last — \"drop this bet\" means close the PR, then the task",
      "refused while a question is pending on the task: answer it instead, since an answer is free text and any instruction fits in one",
      "one queued run per loop, so a directive on a busy loop reports that run rather than stacking a twin",
    ],
  },
  "doc show": {
    usage: "loopany doc show <id-or-key> [flags]",
    flags: [["--file", "emit the canonical artifact file instead of the TOON view"], ["--full", "do not truncate the body"]],
    examples: ["loopany doc show doc-2b8e04", "loopany doc show weekly-summary", "loopany doc show doc-2b8e04 --file > d.md"],
    notes: [
      "the creation `key:` addresses the doc too — a run re-reads the product it filed last pass by the key it chose, not by an id it would have to memorize",
    ],
    seeAlso: DOC_KEYS,
  },
  "doc create": {
    usage: "loopany doc create --file <path>",
    flags: [["--file <path>", "the artifact file IS the object; `-` reads stdin"]],
    examples: ["loopany doc create --file weekly-summary.md"],
    notes: [
      "register a product as soon as it exists — partial products survive a dead run",
      "not for the run's own report — that goes to `loopany report`; a doc is a product that outlives the run",
    ],
    seeAlso: DOC_KEYS,
  },
  "doc update": {
    usage: "loopany doc update <id-or-key> --file <path>",
    flags: [["--file <path>", "the replacement artifact: front matter + body; `-` reads stdin"]],
    examples: ["loopany doc show doc-2b8e04 --file > d.md", "loopany doc update doc-2b8e04 --file d.md"],
    notes: [
      "--file is the only input: a doc has no field the kernel acts on, so content is edited as a file",
      "run reports are immutable BY CONVENTION — the kernel accepts the write and says so",
    ],
    seeAlso: DOC_KEYS,
  },
  "mirror attach": {
    usage: "loopany mirror attach <object-id> --kind <kind> --coords <coords> [--note <text>]",
    flags: [
      ["--kind <kind>", "what KIND of external thing (github-pr, url, …); free-form, kebab-cased on write"],
      ["--coords <coords>", "the external thing's IMMUTABLE identity (owner/repo#57, a URL)"],
      ["--note <text>", "a human label for it; optional, one short phrase"],
    ],
    examples: [
      'loopany mirror attach task-7f3a91 --kind github-pr --coords superdesigndev/loopany-platform#57 --note "seed article PR"',
      "loopany mirror attach doc-4b21c7 --kind gsc-property --coords sc-domain:example.com",
    ],
    notes: [
      MIRROR_LAW + " — there is no state field, and the schema has nowhere to put one",
      "creates the mirror and attaches it in ONE transaction; no --file, because a pointer is three fields",
      "ONE external thing is ONE mirror: attaching the same coords from a second object shares the row rather than making a twin",
      "coords are IDENTITY and can never be changed — a different PR is a different mirror",
      MIRROR_KINDS,
    ],
  },
  "mirror detach": {
    usage: "loopany mirror detach <mirror-id> --from <object-id>",
    flags: [["--from <object-id>", "the object that no longer depends on the external thing; required"]],
    examples: ["loopany mirror detach mirror-3f9a21c04b7e --from task-7f3a91"],
    notes: [
      "--from is required: a mirror can hang on several objects, and guessing wrong removes somebody else's pointer",
      "detaching the last attachment is legal — the row stays as a readable record, like everything else in this kernel",
      "detaching a mirror that was not attached is a success that changed nothing, so a retry is free",
    ],
  },
  "mirror list": {
    usage: "loopany mirror list [--attached-to <object-id>] [--kind <kind>] [--coords-like <pattern>]",
    flags: [
      ["--attached-to <object-id>", "the external items THAT object depends on"],
      ["--kind <kind>", "one kind; normalized the same way a write is, so --kind \"GitHub PR\" finds github-pr"],
      ["--coords-like <pattern>", "substring match on coords — `owner/repo#` for one repo's refs"],
    ],
    examples: [
      "loopany mirror list --attached-to task-7f3a91",
      "loopany mirror list --kind github-pr --coords-like superdesigndev/",
    ],
    notes: [
      "predicates compose as AND; a mirror carries no state, so there is nothing to filter by state",
      "`task show` / `doc show` already print the mirrors attached to that object",
    ],
  },
  "mirror kinds": {
    usage: "loopany mirror kinds",
    flags: [],
    examples: ["loopany mirror kinds"],
    notes: [
      "the vocabulary is free-form, so the honest answer is the kinds actually IN USE, with counts",
      "the canonical spellings print alongside, flagged known — an unknown kind is accepted, it just gets no coords check",
    ],
  },
  "mirror show": {
    usage: "loopany mirror show <mirror-id>",
    flags: [],
    examples: ["loopany mirror show mirror-3f9a21c04b7e"],
    notes: [MIRROR_LAW + ": this prints where to look and who depends on it, never whether it is open or merged"],
  },
  "mirror update": {
    usage: 'loopany mirror update <mirror-id> --note "<text>"',
    flags: [["--note <text>", "the human label; `null` clears it"]],
    examples: ['loopany mirror update mirror-3f9a21c04b7e --note "the fix PR, not the seed one"'],
    notes: [
      "the note is the ONLY editable field: kind and coords are the external thing's identity and are refused by name",
      "the label is shared by everything the mirror is attached to — one external thing is one mirror",
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
      "answering wakes the watcher loop — every task names one, so every answer reaches a loop",
    ],
  },
};

/** The legal flag names for a verb — the `allowed[N]:` line of an unknown-flag
 *  refusal, and the local grammar check, read from the same table as the help. */
export function flagNames(command: string): string[] {
  return (VERBS[command]?.flags ?? []).map(([flag]) => flag.split(" ", 1)[0]!);
}

/** Flags this verb RECOGNIZES but refuses (`VerbSpec.retired`). Known enough to
 *  reach the verb's own plan, never advertised as allowed. */
export function retiredFlagNames(command: string): string[] {
  return VERBS[command]?.retired ?? [];
}

export function verbHelp(command: string): string {
  if (command.startsWith("loop ")) return loopSurfacePointer(command);
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
