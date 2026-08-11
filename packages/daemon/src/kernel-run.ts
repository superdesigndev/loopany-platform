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
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingAgent } from "./create.js";
import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { isWithinRoots } from "./roots.js";
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
  /** Backoff sleep between finish retries (timer seam - tests run instantly). */
  sleep: (ms: number) => Promise<void>;
  scratchDir: () => string;
  /** A directory holding a `loopany-kernel` shim to PREPEND to the child PATH
   *  (null = none found; the agent then relies on a global install). */
  kernelBinDir: () => string | null;
}

/** Locate the kernel CLI entry this daemon can hand its agents: the bundled
 *  sibling `dist/kernel-cli.mjs` in the published package, else the workspace
 *  launcher when running from the repo (dev/tsx). Null = neither exists. */
export function resolveKernelCliEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const packed = join(here, "kernel-cli.mjs");
  if (existsSync(packed)) return packed;
  const dev = join(here, "..", "..", "cli", "bin", "loopany-kernel.mjs");
  return existsSync(dev) ? dev : null;
}

let cachedKernelBinDir: string | null | undefined;

/** The CORE prompt (frozen server-side) instructs `loopany-kernel <verb>`, so
 *  that name MUST resolve in the spawned agent's PATH even on an npx-launched
 *  daemon with no global install. We write a one-line sh shim with ABSOLUTE
 *  node + entry paths (the PATH-clobber lesson: login shells rebuild PATH, so
 *  the shim's own content must never depend on it) into a scratch dir the
 *  caller prepends to the child PATH. Cached per process. */
export function ensureKernelBinDir(): string | null {
  if (cachedKernelBinDir !== undefined) return cachedKernelBinDir;
  const entry = resolveKernelCliEntry();
  if (!entry) {
    logger.warn("kernel run: no kernel CLI entry found - agents must have loopany-kernel on PATH");
    cachedKernelBinDir = null;
    return cachedKernelBinDir;
  }
  const dir = mkdtempSync(join(tmpdir(), "loopany-kernel-bin-"));
  writeFileSync(join(dir, "loopany-kernel"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, {
    mode: 0o755,
  });
  cachedKernelBinDir = dir;
  return cachedKernelBinDir;
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
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  scratchDir: () => mkdtempSync(join(tmpdir(), "loopany-kernel-run-")),
  kernelBinDir: ensureKernelBinDir,
};

/** Finish-POST retry ladder (~8.5 min total). Losing the final report is what
 *  used to strand a run as running forever; while we retry, the runId stays in
 *  the daemon's inFlight set, so every poll keeps reporting it and the server's
 *  orphan reconcile WAITS. Only after the ladder is exhausted does the id drop
 *  from inFlight - at which point that same reconcile settles the run as failed
 *  on the next poll (bounded, never silent, never permanent). */
export const FINISH_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 120_000, 300_000];

/** Execute one kernel run delivery end to end. Never throws: every failure path
 *  reports run-finish(failed) with a clear note (the kernel's bounded re-arm
 *  policy takes it from there). `roots` is the daemon's local LOOPANY_ROOTS
 *  jail: a task workdir is SERVER-CARRIED state a team-scoped run credential
 *  can rewrite, so it gets the same jail check as a production loop workdir —
 *  never execute outside the machine owner's allowed roots. */
export async function runKernelDelivery(
  kr: KernelRunDelivery,
  serverUrl: string,
  roots: string[] = [],
  signal?: AbortSignal,
  deps: KernelRunDeps = realKernelRunDeps,
): Promise<void> {
  const finish = async (outcome: "done" | "failed", note: string) => {
    const body = { command: { op: "run-finish", runId: kr.runId, outcome, note } };
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.finish(serverUrl, kr.runToken, body);
        return;
      } catch (err) {
        if (attempt >= FINISH_RETRY_DELAYS_MS.length || signal?.aborted) {
          logger.error(
            { runId: kr.runId, attempts: attempt + 1, err: String(err) },
            "kernel run-finish post failed - giving up; the server's orphan reconcile will settle this run",
          );
          return;
        }
        logger.warn({ runId: kr.runId, attempt: attempt + 1, err: String(err) }, "kernel run-finish post failed, retrying");
        await deps.sleep(FINISH_RETRY_DELAYS_MS[attempt]!);
      }
    }
  };

  const agent = kernelAgentKind(kr.agent);
  if (!agent) {
    await finish("failed", `unknown agent "${kr.agent}" - this daemon executes claude|codex|grok`);
    return;
  }

  // FAIL LOUD on a missing workdir (owner decision): the loop's declared home
  // does not exist on this machine - never quietly run somewhere else. A
  // present workdir must also sit INSIDE the local jail (parity with the
  // production runner's resolveWorkdir); the null-workdir scratch dir is
  // daemon-chosen, never server-chosen, so it is exempt like production's.
  let cwd: string;
  if (kr.workdir !== null) {
    if (roots.length && !isWithinRoots(kr.workdir, roots)) {
      await finish("failed", `workdir ${kr.workdir} is outside this machine's allowed roots`);
      return;
    }
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
  // The prompt's callback verb is `loopany-kernel …`: guarantee it resolves for
  // the child by prepending our shim dir (absolute node + bundled entry inside).
  const shimDir = deps.kernelBinDir();
  if (shimDir) env.PATH = env.PATH ? `${shimDir}:${env.PATH}` : shimDir;

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
