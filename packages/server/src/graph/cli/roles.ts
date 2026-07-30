/**
 * PER-ROLE VERB SUBSETS - captain decision 15(a), and the direct answer to the
 * captain's "agent 会跑崩" concern.
 *
 * Seven verbs handed to every run is a menu; one to three verbs, each with a line
 * saying when to reach for it, is an instruction. So a work order carries a ROLE
 * and the composer prints only that role's verbs. A run that never sees
 * `wait open` cannot open a wait at the wrong moment, and a run that sees three
 * commands has three things to consider rather than seven.
 *
 * The subsets are also ENFORCED, not merely printed (`cli.ts` checks them before
 * dispatch). Printing alone would make the stability story a matter of the model
 * reading carefully; enforcing it makes an out-of-role call a loud, recoverable
 * refusal that names what this run may actually do.
 *
 * ── domain neutrality (decision 17) ─────────────────────────────────────────
 *
 * A role says nothing about a domain. "Fix" is not "fix a GitHub issue" - it is
 * "you were approved to do work; land it, register whatever external thing you
 * produced, and ask for the verdict". A Reddit-posting run and a code-fixing run
 * are the same role with different instructions and different instance data.
 *
 * PURE: no db, no clock, no I/O. The composer that uses it lives in
 * `workOrder.ts`.
 */
import type { RunRole } from "./identity.js";

export interface VerbUsage {
  /** The verb as typed, with its required flags. */
  syntax: string;
  /** WHEN to reach for it. One line - a run reads this once. */
  when: string;
}

/**
 * The seven verbs, with the one-line usage each work order prints. This table is
 * the single source: the role subsets index into it, `--help` renders from it,
 * and the enforcement list is derived from it, so a verb cannot be advertised to
 * a role that may not call it.
 */
export const VERBS: Record<string, VerbUsage> = {
  "task create": {
    syntax: 'graph task create --type <type> --title "<title>" [--field k=v ...]',
    when: "you found a piece of work that should exist in the graph",
  },
  "task move": {
    syntax: "graph task move <id> <transition> [--note “…”]",
    when: "a task you own has genuinely changed state",
  },
  "artifact push": {
    syntax: "graph artifact push <file> [--for <id>] [--replaces <artifact-id>]",
    when: "you produced something a person may read - a report, a draft, a diff",
  },
  "review request": {
    syntax: 'graph review request [--about <id>] --question "<question>" [--preset merge|publish|decision|dispatch]',
    when: "a person has to decide something before this can go further",
  },
  "mirror track": {
    syntax: "graph mirror track <url-or-source:id> [--for <id>]",
    when: "you created or found an external thing the workspace should now know about",
  },
  "wait open": {
    syntax: 'graph wait open <id> --key <key> --question "<question>" --watcher <loop-or-task-id>',
    when: "something outside has to happen before this is done, and somebody must watch for it",
  },
  "wait answer": {
    syntax: 'graph wait answer <id> <key> --met|--not-met --evidence "<what you saw>"',
    when: "you looked, and can now say whether the condition holds",
  },
};

export const ALL_VERBS = Object.keys(VERBS);

/**
 * ROLE → the verbs that role may call, in the order a run would use them.
 *
 *   discovery  a scheduled sweep. It finds something, writes it down, and asks a
 *              person. It deliberately CANNOT move tasks or open waits: a sweep
 *              that starts managing state is a sweep that has stopped sweeping.
 *   fix        approved work. It registers what it produced outside, moves the
 *              task it was given, pushes its report and asks for the merge
 *              verdict. It cannot create new work - that would let one approved
 *              instruction breed more of itself.
 *   watch      a standing question. Two verbs, and that is the entire job:
 *              answer the wait, and leave the evidence behind.
 */
export const ROLE_VERBS: Record<RunRole, string[]> = {
  discovery: ["task create", "artifact push", "review request"],
  fix: ["mirror track", "task move", "review request", "artifact push"],
  watch: ["wait answer", "artifact push"],
};

/** May this role call this verb? Unknown role ⇒ NOTHING, which is the fail-closed
 *  answer: a work order that forgot to name a role must not silently get all
 *  seven verbs. */
export function roleMayCall(role: string | undefined, verb: string): boolean {
  const subset = ROLE_VERBS[(role ?? "") as RunRole];
  return Array.isArray(subset) && subset.includes(verb);
}

export function verbsForRole(role: string | undefined): string[] {
  return ROLE_VERBS[(role ?? "") as RunRole] ?? [];
}

/**
 * The verb section of a work order - what a run of this role actually reads.
 *
 * Deliberately terse and deliberately COMPLETE for its role: syntax, when, and
 * nothing else. A run that has to infer a flag from prose will get it wrong, and
 * a run given seven verbs will use the wrong one.
 */
export function verbSection(role: string | undefined): string[] {
  const verbs = verbsForRole(role);
  if (!verbs.length) return [];
  const lines = [
    "# Your commands",
    "",
    "You have a `graph` command. These are the ONLY verbs available to this run; anything else is refused",
    "with the list of what you may do. Every one is safe to retry - running it twice changes nothing.",
    "",
  ];
  for (const verb of verbs) {
    const usage = VERBS[verb]!;
    lines.push(`- \`${usage.syntax}\``);
    lines.push(`  ${usage.when}`);
  }
  lines.push("");
  lines.push("Every command prints what to do next. Read that line - it is written for the state you are now in.");
  lines.push("A refusal prints what you MAY do instead; follow it rather than trying the same call again.");
  lines.push("Add `--json` to any command when you want to read a field out of the result.");
  lines.push("");
  return lines;
}
