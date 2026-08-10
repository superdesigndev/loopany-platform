/**
 * SIMULATOR scenario types - a scenario is PURE DATA (no I/O, no clock). The
 * engine (engine.ts) interprets it against a sandbox workspace on a virtual
 * clock; the same scenario file can be replayed against any kernel version
 * (local / remote / a future loops adapter) under one rubric, which is the whole
 * point of the design doc (docs/plans/2026-08-10-simulator-scenario-superdesign.md).
 *
 * The unit of a scenario is the virtual DAY. Each day has a `morning` and an
 * `evening` phase; the engine ticks the CLI once per phase (07:00 / 19:00), so a
 * world event tagged "morning" is applied BEFORE the 07:00 cron fire and an
 * "evening" event before the 19:00 follow-up sweep - mirroring the harness loop
 * in §4 of the design doc.
 */

import type { Profiles } from "@loopany/cli";
import type { HumanRule } from "./human.js";

/** A cheap read of the sandbox the harness uses to decide a CONDITIONAL event
 *  (§3.4): the recorded PRs (with the files each changed) and the current task
 *  states. Both are derived from the sandbox by the engine (PRs from the fake
 *  `gh` records; tasks from `lk list --json`) and passed to a `when` predicate. */
export interface WorldProbe {
  /** Every PR the fake `gh` has recorded, with the files each changed (derived
   *  from `git diff base...head` at create time). */
  prs: Array<{ number: number; branch: string; changedFiles: string[] }>;
  /** The current task objects (id + status + assignee) from `lk list --json`. */
  tasks: Array<{ id: string; status: string; assignee: string | null }>;
  /** A cheap read of a WORKSPACE file: true when `<workspace>/<rel>` exists. Lets
   *  a conditional event react to a real content product the agent wrote (§3.4) -
   *  e.g. a scale keyword's page landing before the world lifts its cluster
   *  impressions. Path-jailed to the workspace; a traversal reads false. */
  fileExists: (rel: string) => boolean;
  /** True when `<workspace>/<rel>` exists AND its bytes contain `substring`.
   *  Absent file / traversal reads false (never throws). */
  fileContains: (rel: string, substring: string) => boolean;
  /** True when `<workspace>/<rel>` is a directory containing at least one file.
   *  Gate on the DIRECTORY when the agent picks the filenames itself (round-1
   *  forensics: a hardcoded-filename probe never fired because the agent named
   *  its pages). Absent dir / traversal reads false. */
  dirHasFiles: (rel: string) => boolean;
}

/** A tagged world event - the harness's only channel for playing "the outside
 *  world". A `when` predicate makes an event CONDITIONAL: false defers it (the
 *  engine re-checks it the next day, never drops it), so the world can react to
 *  what the agent actually did (§3.4). Events without `when` always fire. */
export type WorldEvent =
  /** Write (or append to) a mirror file the agent reads. `path` is relative to
   *  the workspace root (e.g. "mirrors/releases.md"). Exactly one of
   *  `content` (overwrite) / `append` (append) is given. Both are subject to
   *  `{{sandbox}}` substitution (the plant-repo path templated in). */
  | {
      kind: "mirror-write";
      path: string;
      content?: string;
      append?: string;
      /** When present, the event fires only if this returns true against the
       *  current probe; otherwise it is DEFERRED to the next day. */
      when?: (probe: WorldProbe) => boolean;
    }
  /** A human reply/note injected onto a task's stream. Runs
   *  `lk note <task> "<text>" --actor <actor>` (human provenance with a named
   *  actor - e.g. tim answering an escalation). */
  | {
      kind: "human-note";
      task: string;
      actor: string;
      text: string;
      when?: (probe: WorldProbe) => boolean;
    };

/** One virtual day of the scenario. */
export interface DayScript {
  /** The ISO DATE (YYYY-MM-DD) this day represents. The engine derives the
   *  07:00/19:00 instants from it. */
  date: string;
  /** Events applied BEFORE the 07:00 cron tick (mirror updates, releases). */
  morning: WorldEvent[];
  /** Events applied BEFORE the 19:00 follow-up tick (human replies, disturbances). */
  evening: WorldEvent[];
  /** When true, this day's ticks run WITHOUT `--spawn`: the clock still fires due
   *  triggers (a pending run is minted), but no agent is launched, so the run is
   *  LEFT pending. The next non-offline day's normal `tick --spawn` claims it -
   *  the durable-inbox catch-up (§4 stopgap). Models a machine offline for a day. */
  offline?: boolean;
}

/** A whole scenario: setup, the executor profiles, and the day-by-day script. */
export interface Scenario {
  /** A stable name (used in log lines + the default out-dir label). */
  name: string;
  /** Raw `lk` argv arrays run ONCE at scenario start, in order (create commands,
   *  initial docs, etc.). Each is executed with a pinned virtual `now` = the
   *  first day's 00:00, so setup is deterministic. `files` (optional) are written
   *  into the workspace BEFORE the commands run - a task's `--body-file` brief
   *  reads one, keeping the scenario pure data (relative path -> content,
   *  `{{sandbox}}`-substituted). */
  setup: { files?: Record<string, string>; tasks: string[][] };
  /** The `profiles` block written into the sandbox workspace config - assignee
   *  name -> executor binding (see @loopany/cli Profile). For the replay tier
   *  this points every agent at shims/replay-agent.mjs. */
  profiles: Profiles;
  /** OPTIONAL replay script (`{ "<taskId>": [ [argv...], ... ] }`) the engine
   *  MATERIALIZES into the sandbox (`<sandbox>/replay-script.json`) and wires as
   *  `LOOPANY_REPLAY_SCRIPT` into the run env itself. Only the replay tier reads
   *  it; a real-agent tier leaves it absent. Keeps the script DATA in the scenario
   *  so a caller never hand-writes the file + extraEnv (P0 ergonomics). */
  replayScript?: Record<string, string[][]>;
  /** OPTIONAL stand-in repos to plant before the days run (§3.4). Each names a
   *  fixture folder under the package's `fixtures/`; the engine copies it in,
   *  git-inits it with a bare origin, and makes it available at
   *  `<sandbox>/repos/<name>` (which a mirror can reach via `{{sandbox}}`). */
  plant?: Array<{ fixture: string; name?: string }>;
  /** OPTIONAL human reply rules (§3.3). Each evening the engine scans the tasks
   *  assigned to a rule's actor and, when a rule is due, injects the scripted
   *  reply as a human note + reassigns the task back to the agent - the low-tier
   *  human-in-the-loop path. Fires once per (rule,task). */
  human?: HumanRule[];
  /** The virtual days, in order. */
  days: DayScript[];
}

/** One CLI invocation's captured result (a tick or a setup/world command). */
export interface SimCommand {
  /** The argv passed to the CLI bin (without the bin path itself). */
  argv: string[];
  /** A human-readable label for progress/summary lines (e.g. "07:00 tick",
   *  "setup: create release-radar", "note release-radar-fix"). Always populated
   *  so a caller can render a run without re-deriving intent from argv. */
  label: string;
  /** The pinned virtual instant (`LOOPANY_NOW`) the command ran at. */
  now: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One virtual day's captured commands + the snapshot dir it produced. */
export interface SimDay {
  date: string;
  /** Every CLI command run for this day, in execution order (morning events,
   *  07:00 tick, evening events, 19:00 tick). */
  commands: SimCommand[];
  /** Absolute path to this day's snapshot dir under out/<runId>/day-<N>/. */
  snapshotDir: string;
}

/** The whole scenario run's structured result. */
export interface SimResult {
  /** The caller-supplied deterministic run id (the out-dir segment). */
  runId: string;
  /** The sandbox workspace dir (holds `.loopany/` + `mirrors/`). */
  workspace: string;
  /** Setup commands (scenario start), in order. */
  setup: SimCommand[];
  /** One entry per virtual day, in order. */
  days: SimDay[];
}
