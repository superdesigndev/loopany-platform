/**
 * The HUMAN ACTOR (§3.3) - a rule-table stand-in for a person (tim) answering
 * escalations. Each evening the engine scans the tasks assigned to the human and,
 * for any whose stream matches a due rule, injects the scripted reply as a HUMAN
 * note and reassigns the task back to the agent (claude), so the follow-up run
 * picks it up. A rule fires ONCE per task (answered ids are tracked).
 *
 * This is the low-tier (scripted) path. A high-tier role-play (a cheap model
 * playing the founder card) would replace `reply` with a generated string; the
 * matching + once-only + reassign mechanics are identical, so it slots in here.
 *
 * The module is a PURE decision over injected reads: `pendingReplies` takes the
 * current tasks + their matched text + the day index + the already-answered set
 * and returns the replies to inject. The engine owns the I/O (running `lk` to
 * read tasks and to write the note/reassign).
 */

/** One human reply rule. `match` is a substring tested against a task's id OR
 *  the text the engine gathered for it (its title/body/notes); `delayDays` is how
 *  many virtual days after the task first matches the reply lands; `reply` is the
 *  scripted note; `reassignTo` (default the agent) is who the task goes back to. */
export interface HumanRule {
  /** The human this rule speaks for (the assignee whose inbox is scanned). */
  actor: string;
  /** Substring matched against the task id or its gathered text. */
  match: string;
  /** Virtual-day delay from first match to the reply landing. */
  delayDays: number;
  /** The scripted reply note (subject to `{{sandbox}}` substitution upstream). */
  reply: string;
  /** Who the task is reassigned to after the reply (default "claude"). */
  reassignTo?: string;
}

/** A task the human sees, plus the text a rule matches against. */
export interface HumanTaskView {
  id: string;
  assignee: string | null;
  /** id + title + body + recent notes, lower-cased by the caller-free matcher. */
  text: string;
}

/** A reply the engine should inject this evening. */
export interface HumanReply {
  taskId: string;
  reply: string;
  reassignTo: string;
}

/** State the engine threads across days: per (rule,task) the day the match was
 *  FIRST seen (so `delayDays` counts from there), and the set already answered. */
export interface HumanState {
  /** `${match}::${taskId}` -> the 0-based day index the match was first seen. */
  firstSeen: Record<string, number>;
  /** `${match}::${taskId}` keys already answered (fire once). */
  answered: Set<string>;
}

export function newHumanState(): HumanState {
  return { firstSeen: {}, answered: new Set<string>() };
}

/** Decide the replies to inject on `dayIndex` (0-based). PURE: it records first
 *  matches into `state.firstSeen`, marks answered ids, and returns the due
 *  replies. The engine applies them (note + reassign) and persists `state`. */
export function pendingReplies(
  rules: HumanRule[],
  tasks: HumanTaskView[],
  dayIndex: number,
  state: HumanState,
): HumanReply[] {
  const answered = state.answered;
  const out: HumanReply[] = [];

  for (const rule of rules) {
    const needle = rule.match.toLowerCase();
    for (const task of tasks) {
      if (task.assignee !== rule.actor) continue;
      const key = `${rule.match}::${task.id}`;
      if (answered.has(key)) continue;
      const matches = task.id.toLowerCase().includes(needle) || task.text.includes(needle);
      if (!matches) continue;
      // Record the first day this (rule,task) matched; the reply lands delayDays later.
      if (state.firstSeen[key] === undefined) state.firstSeen[key] = dayIndex;
      if (dayIndex - state.firstSeen[key] < rule.delayDays) continue;
      answered.add(key);
      out.push({ taskId: task.id, reply: rule.reply, reassignTo: rule.reassignTo ?? "claude" });
    }
  }
  return out;
}
