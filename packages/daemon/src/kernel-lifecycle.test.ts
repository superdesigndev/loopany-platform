/**
 * SHARED KERNEL LIFECYCLE (kernel-real-daemon-simulator): the ONE owner of
 * receive-and-execute for kernel deliveries. Pins the anti-drift facts:
 * the poll body always carries the REAL kernelInFlight (never a `[]` lie),
 * dispatch dedups against the shared set, executions settle, pumpUntilDry
 * loops until a dry round - and daemon.ts consumes THIS module (source guard),
 * so simulator and daemon lifecycle semantics cannot drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KernelLifecycle } from "./kernel-lifecycle.js";
import type { KernelRunDeps, KernelRunDelivery } from "./kernel-run.js";

const KR = (runId: string): KernelRunDelivery => ({
  runId,
  taskId: "t1",
  runToken: `rk_${runId}`,
  prompt: "[loop run]",
  workdir: null,
  agent: "claude",
});

/** Deps that record spawns/finishes without a real process or network. */
function fakeDeps(): { deps: KernelRunDeps; spawned: string[]; finished: string[] } {
  const spawned: string[] = [];
  const finished: string[] = [];
  const deps: KernelRunDeps = {
    isDirectory: () => true,
    run: async (_bin, _args, opts) => {
      spawned.push(String(opts.env.LOOPANY_RUN_ID));
      return { code: 0 };
    },
    finish: async (_url, token) => {
      finished.push(token);
    },
    sleep: async () => {},
    scratchDir: () => "/tmp/scratch",
    kernelBinDir: () => null,
  };
  return { deps, spawned, finished };
}

/** A fetch seam returning scripted per-call poll responses and recording the
 *  poll bodies it saw. */
function fakeFetch(rounds: KernelRunDelivery[][]): {
  fetchImpl: (url: string, init: { body?: unknown }) => Promise<Response>;
  bodies: Array<{ kernelInFlight: string[] }>;
} {
  const bodies: Array<{ kernelInFlight: string[] }> = [];
  let call = 0;
  const fetchImpl = async (_url: string, init: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init.body)) as { kernelInFlight: string[] });
    const kernelRuns = rounds[Math.min(call++, rounds.length - 1)] ?? [];
    return new Response(JSON.stringify({ kernelRuns }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as never, bodies };
}

describe("KernelLifecycle", () => {
  it("polls with the REAL kernelInFlight, dispatches, settles, and dries out", async () => {
    const { deps, spawned, finished } = fakeDeps();
    const { fetchImpl, bodies } = fakeFetch([[KR("run-1"), KR("run-2")], [KR("run-3")], []]);
    const lc = new KernelLifecycle({
      server: "https://srv.example",
      token: "dk_t",
      info: { host: "h", alias: "sim" },
      runDeps: deps,
      fetchImpl: fetchImpl as never,
    });
    const report = await lc.pumpUntilDry();
    expect(report).toEqual({ delivered: 3, rounds: 3 });
    expect(spawned.sort()).toEqual(["run-1", "run-2", "run-3"]);
    expect(finished.sort()).toEqual(["rk_run-1", "rk_run-2", "rk_run-3"]);
    // Every poll body carried the field (ALWAYS present, even empty) and the
    // final dry poll reported an EMPTY set - everything settled.
    for (const b of bodies) expect(Array.isArray(b.kernelInFlight)).toBe(true);
    expect(bodies.at(-1)!.kernelInFlight).toEqual([]);
    expect(lc.inFlight.size).toBe(0);
  });

  it("dedups a re-delivered run against the SHARED in-flight set", async () => {
    const { deps, spawned } = fakeDeps();
    const shared = new Set<string>(["run-1"]); // the daemon already executes it
    const lc = new KernelLifecycle({
      server: "https://srv.example",
      token: "dk_t",
      info: {},
      runDeps: deps,
      inFlight: shared,
    });
    lc.dispatch([KR("run-1"), KR("run-2")]);
    await lc.settle();
    expect(spawned).toEqual(["run-2"]); // run-1 never double-spawned
  });

  it("PARITY GUARD: daemon.ts consumes this module for kernel runs (no second protocol)", () => {
    const rel = "./daemon.ts";
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(src).toContain("kernelLifecycle.dispatch(data.kernelRuns)");
    expect(src).not.toContain("runKernelDelivery("); // execution never inlined again
    // The poll body builder lives HERE (one body shape for daemon + driver).
    expect(src).toContain('import { buildPollBody, KernelLifecycle } from "./kernel-lifecycle.js"');
  });
});
