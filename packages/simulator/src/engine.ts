/**
 * The scenario ENGINE - the day loop that drives a scenario against a sandbox.
 *
 * Per the harness loop (§4 of the design doc):
 *
 *   createSandbox + init                     # a fresh --no-register workspace
 *   run setup commands                       # create loops/tasks/docs
 *   for each day:
 *     apply morning events                   # mirror updates, releases
 *     tick 07:00 --spawn                     # cron loops fire; agents run
 *     apply evening events                   # human replies, disturbances
 *     tick 19:00 --spawn                     # follow-up sweep
 *     snapshot                               # full state -> out/<runId>/day-N
 *
 * Every CLI invocation is the ACTUAL `loopany-kernel` bin (execFile on the .mjs,
 * resolved via sandbox.kernelBinPath - never a hardcoded path). The virtual
 * clock rides as the `LOOPANY_NOW` ENV var (not the --now flag): the env form is
 * what spawn.ts propagates into the agents the tick spawns, so a scripted
 * command inside a run sees the same virtual instant. A nonzero tick is RECORDED,
 * never thrown - a scenario must survive a refusal to be scored.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kernelBinPath, createSandbox, fixturesDir, plantRepo, type Sandbox } from "./sandbox.js";
import { captureDay } from "./snapshot.js";
import { buildProbe } from "./probe.js";
import {
  newHumanState,
  pendingReplies,
  type HumanRule,
  type HumanState,
  type HumanTaskView,
} from "./human.js";
import { applyMirrorWrite, humanNoteArgv, humanNoteEnv, substituteSandbox } from "./world.js";
import type {
  DayScript,
  Scenario,
  SimCommand,
  SimDay,
  SimResult,
  WorldEvent,
  WorldProbe,
} from "./types.js";

const MORNING = "07:00:00.000Z";
const EVENING = "19:00:00.000Z";

export interface RunOpts {
  /** The deterministic run id - the `out/<runId>/` segment. REQUIRED (never
   *  Date.now, so the engine stays deterministic and re-runnable). */
  runId: string;
  /** An explicit sandbox root; defaults to a fresh temp dir. */
  dir?: string;
  /** Extra env for the sandbox (the P1 claude-identity hook point). */
  extraEnv?: Record<string, string>;
}

/** Run a scenario end to end. Returns the structured capture (setup + per-day
 *  commands + snapshot dirs); the sandbox workspace is left on disk for
 *  inspection (a temp dir the OS reclaims, or the caller's `dir`). */
export function runScenario(scenario: Scenario, opts: RunOpts): SimResult {
  // Setup runs at the first day's 00:00 (deterministic, before any tick).
  const firstDate = scenario.days[0]?.date ?? "2026-01-01";
  const setupNow = instant(firstDate, "00:00:00.000Z");

  // The engine MATERIALIZES the scenario's optional replay script into the
  // sandbox and wires LOOPANY_REPLAY_SCRIPT itself, so a caller never hand-writes
  // the file + extraEnv (P0 ergonomics). A caller-supplied LOOPANY_REPLAY_SCRIPT
  // still wins (explicit override). The path lives under the sandbox root, which
  // createSandbox will create; we write AFTER createSandbox so the dir exists.
  const extraEnv = { ...opts.extraEnv };
  const sandbox = createSandbox(
    { dir: opts.dir, profiles: scenario.profiles, extraEnv },
    setupNow,
  );
  if (scenario.replayScript && extraEnv.LOOPANY_REPLAY_SCRIPT === undefined) {
    const scriptPath = join(sandbox.root, "replay-script.json");
    writeFileSync(scriptPath, JSON.stringify(scenario.replayScript));
    // Layer it onto the sandbox env in place so every spawned run inherits it.
    sandbox.env.LOOPANY_REPLAY_SCRIPT = scriptPath;
  }

  // Plant the stand-in repos before setup, so a setup command (or a mirror) can
  // reference the on-disk repo path via `{{sandbox}}`.
  for (const p of scenario.plant ?? []) {
    plantRepo(sandbox, join(fixturesDir(), p.fixture), p.name);
  }

  // Setup files (e.g. a `--body-file` brief) land in the workspace before the
  // setup commands, `{{sandbox}}`-substituted and path-jailed to the workspace.
  for (const [rel, content] of Object.entries(scenario.setup.files ?? {})) {
    const target = join(sandbox.workspace, rel);
    if (!target.startsWith(join(sandbox.workspace, ""))) {
      throw new Error(`setup file "${rel}" escapes the workspace`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, substituteSandbox(content, sandbox.root));
  }

  const setup: SimCommand[] = [];
  for (const argv of scenario.setup.tasks) {
    setup.push(execCli(sandbox, argv, setupNow, undefined, labelFor("setup", argv)));
  }

  // Deferred CONDITIONAL events carry forward: an event whose `when` returned
  // false is re-checked the NEXT day (never dropped, §3.4). Morning and evening
  // buckets keep separate deferral queues so a morning event does not fire at
  // 19:00 (and vice versa), preserving phase semantics.
  let deferredMorning: WorldEvent[] = [];
  let deferredEvening: WorldEvent[] = [];
  const humanState = newHumanState();

  const days: SimDay[] = [];
  scenario.days.forEach((day, i) => {
    const morning = [...deferredMorning, ...day.morning];
    const evening = [...deferredEvening, ...day.evening];
    const result = runDay(sandbox, day, morning, evening, i, i + 1, opts.runId, {
      rules: scenario.human ?? [],
      state: humanState,
    });
    deferredMorning = result.deferredMorning;
    deferredEvening = result.deferredEvening;
    days.push(result.simDay);
  });

  return { runId: opts.runId, workspace: sandbox.workspace, setup, days };
}

interface DayResult {
  simDay: SimDay;
  deferredMorning: WorldEvent[];
  deferredEvening: WorldEvent[];
}

function runDay(
  sandbox: Sandbox,
  day: DayScript,
  morning: WorldEvent[],
  evening: WorldEvent[],
  dayZeroIndex: number,
  dayNumber: number,
  runId: string,
  human: { rules: HumanRule[]; state: HumanState },
): DayResult {
  const commands: SimCommand[] = [];

  // An OFFLINE day still ticks (due triggers fire, minting pending runs) but runs
  // WITHOUT `--spawn`, so no agent is launched and the runs stay pending for the
  // next online day's tick to claim (the durable-inbox catch-up, §4). The `tick`
  // argv drops the flag; everything else about the day is identical.
  const tickArgv = day.offline ? ["tick"] : ["tick", "--spawn"];

  const morningNow = instant(day.date, MORNING);
  const deferredMorning = applyEvents(sandbox, morning, morningNow, commands);
  commands.push(execCli(sandbox, tickArgv, morningNow, undefined, "07:00 tick"));

  const eveningNow = instant(day.date, EVENING);
  const deferredEvening = applyEvents(sandbox, evening, eveningNow, commands);
  // The human actor scans the evening's tasks (§3.3) and injects due replies
  // BEFORE the 19:00 follow-up tick, so the reassigned-back task is claimed then.
  if (human.rules.length > 0) {
    applyHumanReplies(sandbox, human, dayZeroIndex, eveningNow, commands);
  }
  commands.push(execCli(sandbox, tickArgv, eveningNow, undefined, "19:00 tick"));

  const snapshotDir = captureDay(sandbox.workspace, runId, dayNumber);
  return {
    simDay: { date: day.date, commands, snapshotDir },
    deferredMorning,
    deferredEvening,
  };
}

/** Run the human actor for one evening: read the current tasks, compute the due
 *  replies (once-only, delay-aware), and apply each as a HUMAN note + a reassign
 *  back to the agent. Every action is recorded as a command. */
function applyHumanReplies(
  sandbox: Sandbox,
  human: { rules: HumanRule[]; state: HumanState },
  dayZeroIndex: number,
  now: string,
  commands: SimCommand[],
): void {
  const listCmd = execCli(sandbox, ["list", "--json"], now, undefined, "human: list");
  commands.push(listCmd);
  const tasks = humanTaskViews(listCmd.stdout);
  const replies = pendingReplies(human.rules, tasks, dayZeroIndex, human.state);
  for (const reply of replies) {
    // The reply is a HUMAN note (LOOPANY_ACTOR, no session -> entrance=human).
    const actor =
      human.rules.find((r) => (r.reassignTo ?? "claude") === reply.reassignTo)?.actor ?? "human";
    const text = substituteSandbox(reply.reply, sandbox.root);
    commands.push(
      execCli(sandbox, ["note", reply.taskId, text], now, { LOOPANY_ACTOR: actor }, `${actor} note ${reply.taskId}`),
    );
    // Reassign the task back to the agent so the follow-up run picks it up.
    commands.push(
      execCli(
        sandbox,
        ["update", reply.taskId, `assignee=${reply.reassignTo}`],
        now,
        { LOOPANY_ACTOR: actor },
        `${actor} reassign ${reply.taskId} -> ${reply.reassignTo}`,
      ),
    );
  }
}

/** Build the human's task views from `lk list --json` (id + assignee + a text
 *  blob for matching: id + title, lower-cased). The tree wire shape is
 *  `[{task: {...}, children: [...]}]` - the task fields live under `.task`,
 *  NOT on the node itself (the haiku-1 postmortem: reading the node left the
 *  scan permanently empty and tim never replied). */
export function humanTaskViews(listJson: string): HumanTaskView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return [];
  }
  const out: HumanTaskView[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const t = (o.task && typeof o.task === "object" ? o.task : o) as Record<string, unknown>;
      if (typeof t.id === "string" && (t.archetype === "task" || t.status !== undefined)) {
        const title = typeof t.title === "string" ? t.title : "";
        // Body included (clipped): haiku-2 named its escalation task
        // "risk-library-agent-dropdown" - the rule word lived only in the BODY,
        // so an id+title match left tim silent a second time.
        const body = typeof t.body === "string" ? t.body.slice(0, 2000) : "";
        out.push({
          id: t.id,
          assignee: typeof t.assignee === "string" ? t.assignee : null,
          text: `${t.id} ${title} ${body}`.toLowerCase(),
        });
      }
      if (Array.isArray(o.children)) for (const c of o.children) visit(c);
    }
  };
  visit(parsed);
  return out;
}

/** Apply a phase's events in order, PUSHING their CLI commands (if any) onto
 *  `commands`, and RETURNING the events whose `when` predicate deferred them.
 *  A conditional event reads a fresh probe each time it is considered (§3.4). */
function applyEvents(
  sandbox: Sandbox,
  events: WorldEvent[],
  now: string,
  commands: SimCommand[],
): WorldEvent[] {
  const deferred: WorldEvent[] = [];
  for (const event of events) {
    if (event.when && !event.when(probeNow(sandbox, now))) {
      deferred.push(event);
      continue;
    }
    commands.push(...applyEvent(sandbox, event, now));
  }
  return deferred;
}

/** Build the world probe: recorded PRs (fs) + task states (`lk list --json`) +
 *  workspace file reads (the file-probe conditional path, §3.4). */
function probeNow(sandbox: Sandbox, now: string): WorldProbe {
  const list = execCli(sandbox, ["list", "--json"], now, undefined, "probe: list");
  return buildProbe(sandbox.root, list.stdout, sandbox.workspace);
}

/** Apply one world event. A `mirror-write` is a direct fs write (no CLI); a
 *  `human-note` is an `lk note` CLI command (recorded like any other). Both are
 *  subject to `{{sandbox}}` substitution. */
function applyEvent(sandbox: Sandbox, event: WorldEvent, now: string): SimCommand[] {
  if (event.kind === "mirror-write") {
    applyMirrorWrite(sandbox.workspace, event, sandbox.root);
    return [];
  }
  return [
    execCli(
      sandbox,
      humanNoteArgv(event, sandbox.root),
      now,
      humanNoteEnv(event),
      `${event.actor} note ${event.task}`,
    ),
  ];
}

/** Execute the CLI bin with a pinned virtual `now`. Captures stdout/stderr/exit;
 *  NEVER throws on a nonzero exit (the caller records refusals for scoring).
 *  `envOverride` layers per-command keys (e.g. a human-note's actor) on top. */
function execCli(
  sandbox: Sandbox,
  argv: string[],
  now: string,
  envOverride?: Record<string, string>,
  label?: string,
): SimCommand {
  const child = spawnSync(process.execPath, [kernelBinPath(), ...argv], {
    cwd: sandbox.workspace,
    env: { ...sandbox.env, LOOPANY_NOW: now, ...envOverride },
    encoding: "utf8",
  });
  return {
    argv,
    label: label ?? labelFor(argv[0] ?? "cli", argv),
    now,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    exitCode: child.status ?? (child.error ? 127 : 1),
  };
}

/** Compose an ISO instant from a date + a time-of-day suffix. */
function instant(date: string, timeOfDay: string): string {
  return `${date}T${timeOfDay}`;
}

/** A concise human label for a captured command. `prefix` tags the phase (e.g.
 *  "setup"); the verb + its first positional read as the intent. */
function labelFor(prefix: string, argv: string[]): string {
  const verb = argv[0] ?? "";
  const arg = argv[1] && !argv[1].startsWith("-") ? ` ${argv[1]}` : "";
  return `${prefix}: ${verb}${arg}`.trim();
}
