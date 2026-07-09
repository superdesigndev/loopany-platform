/**
 * A delivery is everything the daemon needs to run one loop tick: the loop's
 * machine-side config + the server-composed system prompt and task. The daemon
 * writes the prompt to a file, runs the workflow gate (if any), then claude.
 */
import type { CodingAgent, Loop } from "../db/schema.js";
import * as store from "../db/store.js";
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
    /** Coding agent to EXECUTE this loop with (the daemon branches its spawn on
     *  this — claude vs grok; codex still runs via claude today). */
    agent: CodingAgent;
  };
  /** Cursor (prev state) for the workflow gate. */
  prevState: unknown;
  /** Machine workdir jail (server-configured; daemon enforces). [] = unrestricted. */
  roots: string[];
  systemPrompt: string;
  task: string;
}

export async function buildDelivery(loop: Loop, runId: string, runToken: string, roots: string[]): Promise<Delivery> {
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
      task = buildExecTask(loop);
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
    },
    prevState: loop.state ?? null,
    systemPrompt,
    task,
  };
}
