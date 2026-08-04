/**
 * Rewrite kernel — the pure vocabulary: kinds, statuses, entrances, the
 * transition table, the kind firewalls and the typed refusal envelope.
 *
 * This module has NO imports and NO I/O, so every rule in it is unit-testable
 * without a database. `applyTransition.ts` is the only place that acts on it.
 *
 * Contract anchors: design §2 (entities), §3 (task states), §4 (loop firewalls),
 * §10 principle 3 ("a state exists only if the kernel must enforce something
 * about it"); server contract §3.2 (the code table), §4 (transaction semantics).
 */

// ---- kinds and statuses ----

/** Single-table inheritance: three kinds, one `objects` table (design §2). */
export const OBJECT_KINDS = ["loop", "task", "doc"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** `open → closed`. Nothing else (design §3) — everything that feels like a
 *  state is a facet (`pending_question`, `follow_up_at`) or a run's lease. */
export const TASK_STATUSES = ["open", "closed"] as const;
/** Operational lifecycle. A loop never closes by finishing work (design §4). */
export const LOOP_STATUSES = ["active", "paused", "retired"] as const;
/** A doc has one state; `doc update` rewrites it in place (design §8). */
export const DOC_STATUSES = ["current"] as const;

export const STATUSES_BY_KIND: Record<ObjectKind, readonly string[]> = {
  task: TASK_STATUSES,
  loop: LOOP_STATUSES,
  doc: DOC_STATUSES,
};

/** The status a freshly created object of each kind carries. Creation is NOT a
 *  transition — the object has no prior state to guard (§4.1). */
export const INITIAL_STATUS: Record<ObjectKind, string> = {
  task: "open",
  loop: "active",
  doc: "current",
};

// ---- events ----

/** How the event's id was minted — which half of the dedup invariant applies
 *  (§5.4). `derived` ⇒ content-derived id + ON CONFLICT DO NOTHING. */
export const EVENT_ORIGINS = ["derived", "organic"] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

/**
 * Design §2's four-value entrance set — deliberately NOT the graph line's
 * (`human | agent-run | rule | clock`). The rewrite has no rule engine and it has
 * a birth rule the graph line did not (`answer`), so the harvest is adapted.
 */
export const ENTRANCES = ["clock", "answer", "human", "agent"] as const;
export type Entrance = (typeof ENTRANCES)[number];

/** Per-field `{old, new}` — the payload-sufficiency record (§4.3). */
export type EventDiff = Record<string, { old: unknown; new: unknown }>;

/** PROVENANCE: which entrance produced a write plus the concrete actor behind
 *  it (a run id, a user id). Never a placeholder — it cannot be backfilled. */
export interface Actor {
  entrance: Entrance;
  actorId: string;
}

// ---- runs queue (the columns unit 3 drives; the vocabulary lives here) ----

export const RUN_QUEUE_STATES = ["queued", "claimed", "success", "failure"] as const;
export type RunQueueState = (typeof RUN_QUEUE_STATES)[number];

/**
 * Why this run exists (§5.3). `clock` = R-clock (the loop's own cadence),
 * `answered` = R-answer (a human answered a task this loop watches), `due` =
 * R-due (a task this loop watches reached its `follow_up`), `manual` = a person
 * pressed the button. `due` joined the set under the 2026-08-04 watcher ruling:
 * with every task watched, a follow-up date is a real alarm on a named loop, so
 * the same level-triggered clock that fires cadences fires it.
 */
export const RUN_REASONS = ["clock", "answered", "due", "manual"] as const;
export type RunReason = (typeof RUN_REASONS)[number];

/** `active` until the lease expires; `terminal-grace` admits exactly ONE late
 *  reconciling report from a machine that woke up (§6.5). */
export const RUN_LEASE_STATES = ["active", "terminal-grace"] as const;
export type RunLeaseState = (typeof RUN_LEASE_STATES)[number];

/** `routine` (the loop's own cadence) or `task:<object id>` (an express run). */
export const ROUTINE_SCOPE = "routine";

// ---- the transition table ----

export interface TransitionSpec {
  /** The ONLY kind this transition applies to — the kind firewall, as data. */
  kind: ObjectKind;
  from: readonly string[];
  to: string;
  /** The event kind written for it (`events.kind`). */
  eventKind: string;
}

/**
 * Every status change in the system. There are five, and there is no path to a
 * sixth without editing this table — which is design §10 principle 3 made
 * mechanical.
 *
 * `auto-pause` is a separate NAME from `pause` on purpose: §6.6's circuit
 * breaker must be distinguishable from an owner's deliberate pause when reading
 * the timeline, and the transition name is the only field that carries it.
 */
export const TRANSITIONS = {
  close: { kind: "task", from: ["open"], to: "closed", eventKind: "task-closed" },
  pause: { kind: "loop", from: ["active"], to: "paused", eventKind: "loop-paused" },
  "auto-pause": { kind: "loop", from: ["active"], to: "paused", eventKind: "loop-paused" },
  resume: { kind: "loop", from: ["paused"], to: "active", eventKind: "loop-resumed" },
  retire: { kind: "loop", from: ["active", "paused"], to: "retired", eventKind: "loop-retired" },
} as const satisfies Record<string, TransitionSpec>;

export type TransitionName = keyof typeof TRANSITIONS;

export function isTransitionName(v: string): v is TransitionName {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, v);
}

// ---- the kind firewalls (design §4, welded twice: here and in the DDL) ----

/** A cadence and a bound workdir are loop facets. `--cron` on a task is refused
 *  (design §4 rule 2); `workdir` joined them under the 2026-08-04 captain ruling
 *  that a loop binds a directory the way the shipping product does. */
export const LOOP_ONLY_FIELDS = ["cron", "timezone", "nextFire", "workdir"] as const;
/** Question / resurface date / who-acts-next are task facets. */
export const TASK_ONLY_FIELDS = ["followUpAt", "pendingQuestion", "watcher"] as const;
/** `format: html` is a doc narrow door (design §7). */
export const DOC_ONLY_FIELDS = ["format"] as const;

const FACET_OWNER: Record<string, ObjectKind> = {
  ...Object.fromEntries(LOOP_ONLY_FIELDS.map((f) => [f, "loop" as const])),
  ...Object.fromEntries(TASK_ONLY_FIELDS.map((f) => [f, "task" as const])),
  ...Object.fromEntries(DOC_ONLY_FIELDS.map((f) => [f, "doc" as const])),
};

/** Fields any kind may carry. Everything else is either a facet (above) or is
 *  not writable through the kernel at all (`id`, `kind`, `status`, `key`). */
export const COMMON_FIELDS = ["title", "body", "payload"] as const;

/** Never writable after creation — identity and the guarded state column. */
export const IMMUTABLE_FIELDS = ["id", "kind", "key", "status", "teamId", "createdAt"] as const;

// ---- the refusal envelope (server contract §3.1) ----

export interface KernelIssue {
  /** Dotted field path — a front-matter key or a JSON body key, never an offset. */
  path: string;
  message: string;
  got?: string;
  expected?: string;
}

/**
 * The subset of §3.2's code table this unit can produce. HTTP status mapping
 * lives in unit 4 — the kernel returns the code, never a status.
 */
export type KernelErrorCode =
  | "NOT_FOUND"
  | "WRONG_KIND"
  | "UNKNOWN_KEY"
  | "IMMUTABLE_KEY"
  | "UNKNOWN_TRANSITION"
  | "ILLEGAL_FROM_STATE"
  | "OPEN_QUESTION"
  | "CLOSED"
  | "NOT_HUMAN"
  | "KEY_KIND_MISMATCH"
  | "SCHEMA_VIOLATION"
  /** A task was created or updated with no loop watching it. Its own code
   *  because "who acts next" is the one task facet that may never be empty
   *  (captain ruling 2026-08-04) — see `WATCHER_RULE` below. */
  | "WATCHER_REQUIRED"
  /** An INVARIANT BREACH, not a user error: a short id resolved to a row that is
   *  not the identity the caller meant. Its own code because the only honest
   *  answer to a truncation collision is a loud, attributable failure — the
   *  alternative is silently operating on a stranger's object. */
  | "ID_COLLISION";

export interface KernelRefusal {
  ok: false;
  code: KernelErrorCode;
  message: string;
  /** Field-level detail; `[]` when the refusal is not field-shaped. */
  issues: KernelIssue[];
  /** The legal next move(s) — never empty when one exists, never speculative. */
  hint?: string;
}

export function refuse(
  code: KernelErrorCode,
  message: string,
  issues: KernelIssue[] = [],
  hint?: string,
): KernelRefusal {
  return { ok: false, code, message, issues, ...(hint ? { hint } : {}) };
}

/**
 * THE FIELD FIREWALL, pure. Given the kind of the row being written and the
 * field names the write carries, return one issue per field that belongs to a
 * DIFFERENT kind.
 *
 * The DDL's four CHECK constraints are the floor (a cron on a task cannot reach
 * the disk even if this were removed); this is the TEACHING surface — the
 * §3.3 special-cased hints exist because "unknown key" alone does not tell an
 * agent where a cadence actually lives.
 */
export function firewallIssues(kind: ObjectKind, fields: Iterable<string>): KernelIssue[] {
  const issues: KernelIssue[] = [];
  for (const field of fields) {
    const owner = FACET_OWNER[field];
    if (!owner || owner === kind) continue;
    issues.push({
      path: field,
      message:
        field === "cron" || field === "timezone" || field === "nextFire"
          ? "a cadence belongs to a loop, not a " + kind
          : field === "workdir"
            ? "a bound working directory belongs to a loop, not a " + kind
            : `${field} is a ${owner} facet, not a ${kind} one`,
      got: field,
    });
  }
  return issues;
}

/** The one-line teaching hint for a firewall refusal on `kind`. */
export function firewallHint(kind: ObjectKind): string {
  if (kind === "task") {
    return "tasks have no cadence. A standing schedule is a loop; a resurface date is follow_up:";
  }
  if (kind === "doc") return "docs carry title, key, format and payload; a schedule is a loop's";
  return "loops carry title, cron, workdir and payload (body = the charter); questions and follow-ups are a task's";
}

/** Immutable-field issues for a write that tried to move identity or status. */
export function immutableIssues(fields: Iterable<string>): KernelIssue[] {
  const banned = new Set<string>(IMMUTABLE_FIELDS);
  const issues: KernelIssue[] = [];
  for (const field of fields) {
    if (!banned.has(field)) continue;
    issues.push({
      path: field,
      message:
        field === "status"
          ? "status moves only through a transition, never through an update"
          : `${field} is fixed at creation`,
      got: field,
    });
  }
  return issues;
}

/** A question is "open" when it is present and not blank (§4.3 / §3.4). */
export function hasOpenQuestion(pendingQuestion: string | null | undefined): boolean {
  return typeof pendingQuestion === "string" && pendingQuestion.trim() !== "";
}

// ---- the watcher rule (captain ruling 2026-08-04) ----

/**
 * **A TASK'S WATCHER IS NEVER EMPTY.**
 *
 * `watcher` names the loop that acts next, and the whole rewrite hangs work off
 * it: a human answer wakes the watcher (R-answer), a follow-up date coming due
 * wakes the watcher (R-due), and the Tasks screen groups by it. An unwatched
 * task was therefore never a state — it was work with nobody on the hook, and
 * the system's answer to it was a pile of compensating machinery (an unclaimed
 * pool, a claim-from-pool gesture, an orphan-age floor, a due-unwatched inbox
 * reason). All of that existed to notice the absence. Forbidding the absence
 * deletes the machinery instead of maintaining it.
 *
 * Two halves, and the split is the point:
 *
 *   1. **A loop-created task DEFAULTS to its creator.** A run that files a task
 *      is on the hook for it unless it explicitly hands it to another loop, so
 *      the common case needs no ceremony and cannot be forgotten.
 *   2. **A human/API-created task REQUIRES an explicit watcher.** There is no
 *      creator loop to fall back to, and picking one for the person would be the
 *      platform guessing who is responsible. It refuses and teaches instead.
 *
 * TRANSFER stays (`watcher: <another loop>`); RELEASE — setting it back to
 * nothing — is gone from every surface, because there is no longer a state to
 * release into.
 *
 * Enforced at the kernel's own chokepoints (`createObjectIn`, `applyUpdateIn`)
 * so every caller inherits it: the HTTP verbs, the whole-file replace, the
 * circuit breaker's auto-pause question and the local fixture alike.
 */
export const WATCHER_HINT =
  "name the loop that acts next: watcher: <loop-id> in the front matter, or --watcher <loop-id> on the CLI. `loopany loop list` prints the ids. A task a run files defaults to that run's own loop, so only a hand-off needs the flag.";

/** The refusal for a task with no loop on the hook. `subject` names the task
 *  when it exists (an update) and the attempted create when it does not. */
export function watcherRequired(subject: string, verb: "created" | "updated"): KernelRefusal {
  return refuse(
    "WATCHER_REQUIRED",
    `${subject} would leave no loop watching it, and a task always names the loop that acts next`,
    [{ path: "watcher", message: `a task cannot be ${verb} without a watcher`, got: "(none)", expected: "loop-<id>" }],
    WATCHER_HINT,
  );
}
