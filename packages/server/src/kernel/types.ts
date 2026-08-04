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

/** Single-table inheritance: four kinds, one `objects` table (design §2). */
export const OBJECT_KINDS = ["loop", "task", "doc", "mirror"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * The kinds that are AUTHORED AS A FILE — the ones `parseKindArtifact` accepts
 * and `show --file` emits. A mirror is deliberately outside the set: it is three
 * flag-sized fields (kind, coords, note), so a front-matter file for it would be
 * ceremony around a one-liner, and having no file path is what keeps a mirror
 * from growing a body somebody could cache external state in.
 */
export const ARTIFACT_KINDS = ["loop", "task", "doc"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(kind: ObjectKind): kind is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/** `open → closed`. Nothing else (design §3) — everything that feels like a
 *  state is a facet (`pending_question`, `follow_up_at`) or a run's lease. */
export const TASK_STATUSES = ["open", "closed"] as const;
/** Operational lifecycle. A loop never closes by finishing work (design §4). */
export const LOOP_STATUSES = ["active", "paused", "retired"] as const;
/** A doc has one state; `doc update` rewrites it in place (design §8). */
export const DOC_STATUSES = ["current"] as const;
/**
 * A mirror has ONE state, and the single value is load-bearing rather than a
 * placeholder: `current` says "this row is the current record" and says NOTHING
 * about the external thing. A second status here — `open`, `merged`, `stale` —
 * would be exactly the cached external state the kind exists to forbid, so the
 * set is closed at one and §10 principle 3 ("a state exists only if the kernel
 * must enforce something about it") keeps it there.
 */
export const MIRROR_STATUSES = ["current"] as const;

export const STATUSES_BY_KIND: Record<ObjectKind, readonly string[]> = {
  task: TASK_STATUSES,
  loop: LOOP_STATUSES,
  doc: DOC_STATUSES,
  mirror: MIRROR_STATUSES,
};

/** The status a freshly created object of each kind carries. Creation is NOT a
 *  transition — the object has no prior state to guard (§4.1). */
export const INITIAL_STATUS: Record<ObjectKind, string> = {
  task: "open",
  loop: "active",
  doc: "current",
  mirror: "current",
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
 * pressed the button, `directive` = R-directive (a human told this loop
 * something about a task it watches, without being asked). `due` joined the set
 * under the 2026-08-04 watcher ruling: with every task watched, a follow-up date
 * is a real alarm on a named loop, so the same level-triggered clock that fires
 * cadences fires it.
 *
 * `directive` is its OWN reason rather than a flavour of `answered`, and the
 * split is the point: the two are opposite conversations. `answered` means "you
 * asked a person something and here is the reply" — the agent already framed the
 * decision. `directive` means "a person is telling you something you did not
 * ask about" — the agent has framed nothing, and the run's first job is to work
 * out what the instruction implies against external reality. A run that could
 * not tell them apart would read a directive as an answer to a question it never
 * asked. `runs.reason` is a TS-only drizzle enum, so widening it needs no
 * migration.
 */
export const RUN_REASONS = ["clock", "answered", "due", "manual", "directive"] as const;
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
/** Question / resurface date / who-acts-next / the parent task are task facets.
 *  `parentId` is task-only because hierarchy is a TASK relation: a loop is not a
 *  bigger task and a doc is not a sub-anything. */
export const TASK_ONLY_FIELDS = ["followUpAt", "pendingQuestion", "watcher", "parentId"] as const;
/** `format: html` is a doc narrow door (design §7). */
export const DOC_ONLY_FIELDS = ["format"] as const;
/** The external pointer, its immutable identity, and the objects it hangs on.
 *  See `kernel/mirrors.ts` for why the set stops exactly there. */
export const MIRROR_ONLY_FIELDS = ["mirrorKind", "mirrorCoords", "attachedTo"] as const;

const FACET_OWNER: Record<string, ObjectKind> = {
  ...Object.fromEntries(LOOP_ONLY_FIELDS.map((f) => [f, "loop" as const])),
  ...Object.fromEntries(TASK_ONLY_FIELDS.map((f) => [f, "task" as const])),
  ...Object.fromEntries(DOC_ONLY_FIELDS.map((f) => [f, "doc" as const])),
  ...Object.fromEntries(MIRROR_ONLY_FIELDS.map((f) => [f, "mirror" as const])),
};

/** Fields any kind may carry. Everything else is either a facet (above) or is
 *  not writable through the kernel at all (`id`, `kind`, `status`, `key`).
 *  A MIRROR is the one exception and it is a subtraction, not an addition —
 *  see `MIRROR_FORBIDDEN_FIELDS`. */
export const COMMON_FIELDS = ["title", "body", "payload"] as const;

/**
 * THE STATELESSNESS SUBTRACTION. A mirror carries neither of the two open
 * fields every other kind has: `payload` is the declared free zone and `body` is
 * free text, and either would be somewhere to write `state: merged`. Removing
 * both is what turns "a mirror is never a cache" from a convention into a
 * property — there is no column left that could hold external status.
 *
 * Welded twice, like the kind firewalls: here (the teaching altitude) and in the
 * DDL as `objects_mirror_stateless` (the floor).
 */
export const MIRROR_FORBIDDEN_FIELDS = ["payload", "body"] as const;

/** Never writable after creation — identity and the guarded state column.
 *  `mirrorKind`/`mirrorCoords` are here because coords ARE the external thing's
 *  identity: a different PR is a different mirror, never the same row repointed. */
export const IMMUTABLE_FIELDS = ["id", "kind", "key", "status", "teamId", "createdAt", "mirrorKind", "mirrorCoords"] as const;

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
  /** A write tried to move a mirror's coords or kind. Its own code because the
   *  legal move is not "supply the stored value" (what `IMMUTABLE_KEY` teaches)
   *  but "detach this mirror and attach a new one" — a different external thing
   *  is a different pointer. */
  | "IMMUTABLE_COORDS"
  /** A write tried to give a mirror a body or a payload. Its own code because
   *  the refusal has to say WHY the field is missing rather than that it is
   *  unknown: a mirror is a pointer and deliberately has nowhere to cache state
   *  (`kernel/mirrors.ts` MIRROR_LAW). */
  | "MIRROR_STATELESS"
  /** A task was created or updated with no loop watching it. Its own code
   *  because "who acts next" is the one task facet that may never be empty
   *  (captain ruling 2026-08-04) — see `WATCHER_RULE` below. */
  | "WATCHER_REQUIRED"
  /** A `parent_id` write would put a task inside its own subtree. Its own code
   *  because the offending value is perfectly well-formed and the parent really
   *  exists — what is wrong is the SHAPE of the result, and only a walk of the
   *  ancestor chain can say so. See `PARENT_CYCLE_HINT`. */
  | "PARENT_CYCLE"
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
            : field === "mirrorKind" || field === "mirrorCoords" || field === "attachedTo"
              ? `${field} belongs to a mirror, not a ${kind} — a pointer to an external thing is its own object`
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
  if (kind === "mirror") return MIRROR_STATELESS_HINT;
  return "loops carry title, cron, workdir and payload (body = the charter); questions and follow-ups are a task's";
}

/**
 * THE STATELESSNESS FIREWALL, teaching half. Given the fields a write carries,
 * refuse the two a mirror may never hold. The DDL CHECK is the floor underneath;
 * this is what makes the refusal say why.
 *
 * Only ASSERTED fields count — writing `payload: null` on a mirror is a no-op,
 * not an attempt to give it a free zone, exactly as the kind firewall treats a
 * cleared facet.
 */
export function statelessIssues(kind: ObjectKind, fields: Iterable<string>): KernelIssue[] {
  if (kind !== "mirror") return [];
  const banned = new Set<string>(MIRROR_FORBIDDEN_FIELDS);
  const issues: KernelIssue[] = [];
  for (const field of fields) {
    if (!banned.has(field)) continue;
    issues.push({
      path: field,
      message: `a mirror has no ${field} — ${MIRROR_LAW}`,
      got: field,
      expected: "(nothing: put the finding on the task, not on the pointer)",
    });
  }
  return issues;
}

/** The sentence every mirror-shape refusal ends with. Duplicated from
 *  `kernel/mirrors.ts` deliberately: this module has NO imports, which is what
 *  keeps every rule in it unit-testable without a database. */
export const MIRROR_LAW = "a mirror tells you WHERE to look, never WHAT state it is in";

export const MIRROR_STATELESS_HINT =
  `a mirror carries only its kind, its coords and a note — ${MIRROR_LAW}. Record what you FOUND on the task that owns the work; the mirror stays a pointer, so the next run goes and looks rather than trusting a stale copy.`;

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
          : field === "mirrorCoords" || field === "mirrorKind"
            ? "coords are the external thing's identity: a different PR is a different mirror"
            : `${field} is fixed at creation`,
      got: field,
    });
  }
  return issues;
}

/** The teaching a coords/kind rewrite gets. Named here so the kernel, the HTTP
 *  seam and the CLI all say the same sentence. */
export const MIRROR_COORDS_IMMUTABLE_HINT =
  "detach this mirror and attach a new one: `loopany mirror detach <mirror-id> --from <object-id>` then `loopany mirror attach <object-id> --kind <k> --coords <new>`. Repointing the row would silently rewrite every timeline that already cites it.";

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
  "name the loop that acts next: watcher: <loop-id> in the front matter, or --watcher <loop-id> on the CLI. `loopany loop list` and `loopany loops` both print ids you can name — a watcher may be a kernel loop or one of this machine's production loops, and either id is used verbatim. A paused loop is still a legal watcher: it acts the next time it runs. A task a run files defaults to that run's own loop, so only a hand-off needs the flag.";

/** The teaching a parent that would close a loop gets. Named here so the kernel,
 *  the HTTP seam and the CLI all say the same sentence. */
export const PARENT_CYCLE_HINT =
  "a task tree is a tree: pick a parent that is not this task and not underneath it, or clear the parent to make this task a root. Nothing was written.";

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
