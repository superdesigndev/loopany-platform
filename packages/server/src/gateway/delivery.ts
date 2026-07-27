/**
 * A delivery is everything the daemon needs to run one loop tick: the loop's
 * machine-side config + the server-composed system prompt and task. The daemon
 * writes the prompt to a file, runs the workflow gate (if any), then claude.
 */
import type { CodingAgent, Loop } from "../db/schema.js";
import * as store from "../db/store.js";
import { sha256 } from "./tokens.js";
import {
  buildEditPrompt,
  buildEditTask,
  buildEvolvePrompt,
  buildEvolveTask,
  buildExecTask,
  buildLoopSystemPrompt,
} from "./prompt.js";

export interface Delivery {
  runId: string;
  runToken: string;
  role: "exec" | "evolve" | "edit";
  loop: {
    id: string;
    name: string;
    /** Machine-side cwd; null ⇒ daemon picks a scratch dir. */
    workdir: string | null;
    taskFile: string | null;
    /** Zero-LLM gate JS (run on the machine before escalating). */
    workflow: string | null;
    model: string | null;
    allowControl: boolean;
    /** Coding agent to EXECUTE this loop with (the daemon branches spawn +
     *  credentials on this — claude-code | codex | grok). */
    agent: CodingAgent;
    /** The task's doc (cron-null exec runs only): the daemon materializes it as
     *  TASK.md in the run workdir and pushes it back at close if it changed. */
    taskDoc?: string;
    /** Content hash of `taskDoc` at claim — the close push's base (a stale close
     *  must never overwrite a doc that advanced after a reclaim). */
    taskDocHash?: string;
  };
  /** Cursor (prev state) for the workflow gate. */
  prevState: unknown;
  /** Machine workdir jail (server-configured; daemon enforces). [] = unrestricted. */
  roots: string[];
  systemPrompt: string;
  task: string;
}

/** First daemon release that materializes a delivered `taskDoc` as TASK.md and
 *  pushes it back at close — prompts degrade below this (doc inlined read-only). */
const TASK_DOC_DAEMON_VERSION = [0, 17];

function supportsTaskDoc(daemonVersion: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(daemonVersion ?? "");
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > TASK_DOC_DAEMON_VERSION[0]! || (maj === TASK_DOC_DAEMON_VERSION[0]! && min >= TASK_DOC_DAEMON_VERSION[1]!);
}

export async function buildDelivery(
  loop: Loop,
  runId: string,
  runToken: string,
  roots: string[],
  opts: { daemonVersion?: string | null } = {},
): Promise<Delivery> {
  const raw = (await store.getRun(runId))?.role;
  const role: Delivery["role"] = raw === "evolve" ? "evolve" : raw === "edit" ? "edit" : "exec";
  let systemPrompt: string;
  let task: string;
  switch (role) {
    case "evolve": {
      const recentRuns = (await store.listRuns(loop.id, 13)).filter((r) => r.id !== runId).slice(-12);
      systemPrompt = buildEvolvePrompt();
      task = buildEvolveTask(loop, recentRuns);
      break;
    }
    case "edit":
      systemPrompt = buildEditPrompt();
      task = buildEditTask(loop, loop.editRequest ?? "(no instruction — make no change and report that)");
      break;
    default:
      systemPrompt = buildLoopSystemPrompt(loop);
      task = buildExecTask(loop, { taskDocCapable: supportsTaskDoc(opts.daemonVersion) });
  }
  return {
    runId,
    runToken,
    role,
    roots,
    loop: {
      id: loop.id,
      name: loop.name || loop.id,
      workdir: loop.workdir ?? null,
      taskFile: loop.taskFile ?? null,
      workflow: loop.workflow ?? null,
      model: loop.model ?? null,
      allowControl: loop.allowControl,
      agent: loop.agent,
      // Task runs carry their doc: the daemon writes TASK.md into the workdir
      // and hash-compares at close (the run edits the record where it stands).
      ...(role === "exec" && loop.cron == null
        ? { taskDoc: loop.taskFileContent ?? "", taskDocHash: sha256(loop.taskFileContent ?? "") }
        : {}),
    },
    prevState: loop.state ?? null,
    systemPrompt,
    task,
  };
}
