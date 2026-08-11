/**
 * KERNEL RUN EXECUTION (P0 stage E) - the daemon branch for a `kernelRuns` poll
 * delivery. The server already CLAIMED the kernel run and built the CORE prompt;
 * this module only executes: verify the workdir exists (missing = report the run
 * failed LOUD, never spawn, never a silent fallback cwd), spawn the agent with
 * the prompt as its first user turn, and post the kernel `run-finish` back to
 * /api/kernel/cli under the delivery's rk_ lease.
 *
 * The in-run `loopany-kernel` CLI authenticates entirely off env the spawn
 * injects: LOOPANY_KERNEL_BACKEND (this server) + LOOPANY_KERNEL_TOKEN (the
 * rk_) - the task's workdir is an arbitrary project checkout with no .loopany
 * stub. One immediate spawn retry (parity with the local tick --spawn's
 * transient shield); everything else defers to the kernel's bounded re-arm
 * policy via run-finish(failed).
 *
 * External touches (fs / spawn / fetch) are injectable seams - tests never
 * launch a real agent or network.
 */
import { statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingAgent } from "./create.js";
import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { buildAgentSpawn } from "./runner.js";
import { execEnv, runProcess } from "./spawn.js";

/** What the poll body's `kernelRuns` field carries (server kernel/dispatch.ts). */
export interface KernelRunDelivery {
  runId: string;
  taskId: string;
  runToken: string;
  prompt: string;
  workdir: string | null;
  agent: string;
}

/** Map the assignee's agent segment onto the daemon's executor enum. `claude`
 *  is the kernel-side spelling of `claude-code`. Unknown = null (fail loud). */
export function kernelAgentKind(agent: string): CodingAgent | null {
  if (agent === "claude" || agent === "claude-code") return "claude-code";
  if (agent === "codex") return "codex";
  if (agent === "grok") return "grok";
  return null;
}

export interface KernelRunDeps {
  /** True when the path exists AND is a directory (fs seam). */
  isDirectory: (path: string) => boolean;
  /** Spawn the agent process (spawn seam). */
  run: (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ code: number | null }>;
  /** POST the kernel run-finish (network seam). */
  finish: (serverUrl: string, runToken: string, body: unknown) => Promise<void>;
  scratchDir: () => string;
}

export const realKernelRunDeps: KernelRunDeps = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  run: async (bin, args, opts) => {
    const res = await runProcess(bin, args, { cwd: opts.cwd, env: opts.env, signal: opts.signal });
    return { code: res.code };
  },
  finish: async (serverUrl, runToken, body) => {
    const res = await boundedFetch(`${serverUrl}/api/kernel/cli`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runToken}` },
      body: JSON.stringify(body),
    }, 30_000);
    if (!res.ok) throw new Error(`run-finish HTTP ${res.status}`);
  },
  scratchDir: () => mkdtempSync(join(tmpdir(), "loopany-kernel-run-")),
};

/** Execute one kernel run delivery end to end. Never throws: every failure path
 *  reports run-finish(failed) with a clear note (the kernel's bounded re-arm
 *  policy takes it from there). */
export async function runKernelDelivery(
  kr: KernelRunDelivery,
  serverUrl: string,
  signal?: AbortSignal,
  deps: KernelRunDeps = realKernelRunDeps,
): Promise<void> {
  const finish = async (outcome: "done" | "failed", note: string) => {
    try {
      await deps.finish(serverUrl, kr.runToken, {
        command: { op: "run-finish", runId: kr.runId, outcome, note },
      });
    } catch (err) {
      logger.error({ runId: kr.runId, err: String(err) }, "kernel run-finish post failed");
    }
  };

  const agent = kernelAgentKind(kr.agent);
  if (!agent) {
    await finish("failed", `unknown agent "${kr.agent}" - this daemon executes claude|codex|grok`);
    return;
  }

  // FAIL LOUD on a missing workdir (owner decision): the loop's declared home
  // does not exist on this machine - never quietly run somewhere else.
  let cwd: string;
  if (kr.workdir !== null) {
    if (!deps.isDirectory(kr.workdir)) {
      await finish("failed", `workdir does not exist on this machine: ${kr.workdir}`);
      return;
    }
    cwd = kr.workdir;
  } else {
    cwd = deps.scratchDir();
  }

  const { bin, args } = buildAgentSpawn({ agent, prompt: kr.prompt });
  const env: NodeJS.ProcessEnv = {
    ...execEnv(agent),
    LOOPANY_KERNEL_BACKEND: serverUrl,
    LOOPANY_KERNEL_TOKEN: kr.runToken,
    LOOPANY_TASK_ID: kr.taskId,
    LOOPANY_RUN_ID: kr.runId,
    LOOPANY_SESSION_ID: `spawn-${kr.runId}`,
    LOOPANY_ACTOR: kr.runId,
  };

  let code: number | null;
  try {
    code = (await deps.run(bin, args, { cwd, env, signal })).code;
    if (code !== 0) {
      // ONE immediate retry - the cheapest transient shield (parity with the
      // local tick --spawn); a second failure reaches the kernel's re-arm ladder.
      logger.warn({ runId: kr.runId, code }, "kernel run: nonzero exit, one retry");
      code = (await deps.run(bin, args, { cwd, env, signal })).code;
    }
  } catch (err) {
    await finish("failed", `agent spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await finish(
    code === 0 ? "done" : "failed",
    code === 0 ? "agent run completed (exit 0)" : `agent run failed (exit ${code}, incl. one retry)`,
  );
}
