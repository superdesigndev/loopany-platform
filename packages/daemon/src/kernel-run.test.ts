/**
 * KERNEL RUN EXECUTION (P0 stage E) - injected seams only, no real process or
 * network: workdir fail-loud (missing dir = failed report, agent NEVER
 * spawned), the in-run env contract (backend + rk_ + run identity), the one
 * immediate retry, and the agent-segment mapping.
 */
import { describe, expect, test } from "vitest";
import { kernelAgentKind, runKernelDelivery, type KernelRunDelivery, type KernelRunDeps } from "./kernel-run.js";

const KR: KernelRunDelivery = {
  runId: "run-abc",
  taskId: "seo-bet-manager",
  runToken: "rk_test",
  prompt: "[loop run · seo bet manager]\n...",
  workdir: "/work/superdesign",
  agent: "claude",
};

function deps(over: Partial<KernelRunDeps> & { codes?: Array<number | null> } = {}) {
  const spawns: Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const finishes: Array<{ url: string; token: string; body: unknown }> = [];
  const codes = over.codes ?? [0];
  let call = 0;
  const d: KernelRunDeps = {
    isDirectory: over.isDirectory ?? (() => true),
    run: async (bin, args, opts) => {
      spawns.push({ bin, args, cwd: opts.cwd, env: opts.env });
      return { code: codes[Math.min(call++, codes.length - 1)] ?? 0 };
    },
    finish: async (url, token, body) => {
      finishes.push({ url, token, body });
    },
    scratchDir: () => "/tmp/scratch",
  };
  return { d, spawns, finishes };
}

test("a run executes in its workdir with the in-run env contract, then reports done", async () => {
  const { d, spawns, finishes } = deps();
  await runKernelDelivery(KR, "https://srv.example", undefined, d);

  expect(spawns).toHaveLength(1);
  const s = spawns[0]!;
  expect(s.cwd).toBe("/work/superdesign");
  expect(s.args.join(" ")).toContain(KR.prompt); // prompt is the first user turn
  expect(s.env.LOOPANY_KERNEL_BACKEND).toBe("https://srv.example");
  expect(s.env.LOOPANY_KERNEL_TOKEN).toBe("rk_test");
  expect(s.env.LOOPANY_TASK_ID).toBe("seo-bet-manager");
  expect(s.env.LOOPANY_RUN_ID).toBe("run-abc");

  expect(finishes).toHaveLength(1);
  expect(finishes[0]).toMatchObject({ url: "https://srv.example", token: "rk_test" });
  expect(JSON.stringify(finishes[0]!.body)).toContain('"outcome":"done"');
});

test("a MISSING workdir fails loud: no spawn, run-finish(failed) names the path", async () => {
  const { d, spawns, finishes } = deps({ isDirectory: () => false });
  await runKernelDelivery(KR, "https://srv.example", undefined, d);
  expect(spawns).toHaveLength(0);
  expect(JSON.stringify(finishes[0]!.body)).toContain("workdir does not exist on this machine: /work/superdesign");
});

test("a nonzero exit retries ONCE; a second failure reports failed", async () => {
  const { d, spawns, finishes } = deps({ codes: [1, 1] });
  await runKernelDelivery(KR, "https://srv.example", undefined, d);
  expect(spawns).toHaveLength(2);
  expect(JSON.stringify(finishes[0]!.body)).toContain("incl. one retry");

  const ok = deps({ codes: [1, 0] });
  await runKernelDelivery(KR, "https://srv.example", undefined, ok.d);
  expect(ok.spawns).toHaveLength(2);
  expect(JSON.stringify(ok.finishes[0]!.body)).toContain('"outcome":"done"');
});

test("a null workdir uses a scratch dir; an unknown agent fails without spawning", async () => {
  const { d, spawns } = deps();
  await runKernelDelivery({ ...KR, workdir: null }, "https://srv.example", undefined, d);
  expect(spawns[0]!.cwd).toBe("/tmp/scratch");

  const bad = deps();
  await runKernelDelivery({ ...KR, agent: "gemini" }, "https://srv.example", undefined, bad.d);
  expect(bad.spawns).toHaveLength(0);
  expect(JSON.stringify(bad.finishes[0]!.body)).toContain("unknown agent");
});

describe("kernelAgentKind", () => {
  test("maps the kernel agent segment onto the executor enum", () => {
    expect(kernelAgentKind("claude")).toBe("claude-code");
    expect(kernelAgentKind("claude-code")).toBe("claude-code");
    expect(kernelAgentKind("codex")).toBe("codex");
    expect(kernelAgentKind("grok")).toBe("grok");
    expect(kernelAgentKind("gemini")).toBeNull();
  });
});
