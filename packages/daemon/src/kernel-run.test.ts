/**
 * KERNEL RUN EXECUTION (P0 stage E) - injected seams only, no real process or
 * network: workdir fail-loud (missing dir = failed report, agent NEVER
 * spawned), the in-run env contract (backend + rk_ + run identity), the one
 * immediate retry, and the agent-segment mapping.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentSessionIdFromText,
  ensureKernelBinDir,
  FINISH_RETRY_DELAYS_MS,
  kernelAgentKind,
  runKernelDelivery,
  type KernelRunDelivery,
  type KernelRunDeps,
} from "./kernel-run.js";
import { runWorkflow } from "./workflow.js";

test("host session ids are treated as opaque provider values", () => {
  expect(agentSessionIdFromText('{"type":"system","session_id":"sess-claude_01"}')).toBe("sess-claude_01");
  expect(agentSessionIdFromText('{"session_id":""}')).toBeNull();
});

const KR: KernelRunDelivery = {
  runId: "run-abc",
  taskId: "seo-bet-manager",
  runToken: "rk_test",
  prompt: "[loop run · seo bet manager]\n...",
  workdir: "/work/superdesign",
  agent: "claude",
};

function deps(over: Partial<KernelRunDeps> & { codes?: Array<number | null>; finishFailures?: number } = {}) {
  const spawns: Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const finishes: Array<{ url: string; token: string; body: unknown }> = [];
  const transcripts: unknown[] = [];
  const sleeps: number[] = [];
  const codes = over.codes ?? [0];
  let call = 0;
  let finishFailures = over.finishFailures ?? 0;
  const d: KernelRunDeps = {
    isDirectory: over.isDirectory ?? (() => true),
    run: async (bin, args, opts) => {
      spawns.push({ bin, args, cwd: opts.cwd, env: opts.env });
      return { code: codes[Math.min(call++, codes.length - 1)] ?? 0 };
    },
    finish: async (url, token, body) => {
      if (finishFailures > 0) {
        finishFailures--;
        throw new Error("ECONNREFUSED");
      }
      finishes.push({ url, token, body });
    },
    uploadTranscript: async (_url, _token, _runId, body) => { transcripts.push(body); },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    scratchDir: () => "/tmp/scratch",
    kernelBinDir: over.kernelBinDir ?? (() => "/shim/kernel-bin"),
    runWorkflow: over.runWorkflow ?? (async () => ({ ok: true, result: { agentCalls: [] }, stdout: "", stderr: "" })),
  };
  return { d, spawns, finishes, sleeps, transcripts };
}

test("a run executes in its workdir with the in-run env contract, then reports done", async () => {
  const { d, spawns, finishes } = deps();
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);

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

test("a real Claude stream is uploaded as a shared transcript before run-finish", async () => {
  const { d, transcripts, finishes } = deps();
  d.run = async (_bin, _args, opts) => {
    opts.onStdout?.('{"type":"assistant","session_id":"sess-shared","message":{"content":[{"type":"text","text":"Reviewing the notification path"},{"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"/work/superdesign/src/notify.ts"}}]}}\n');
    opts.onStdout?.('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"export function notify() {}"}]}}\n');
    opts.onStdout?.('{"type":"result","session_id":"sess-shared","total_cost_usd":0.01,"usage":{"input_tokens":12,"output_tokens":5}}');
    return { code: 0 };
  };
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);

  expect(transcripts).toHaveLength(1);
  const body = transcripts[0] as { final: boolean; entries: Array<{ kind: string; text?: string }> };
  expect(body.final).toBe(true);
  expect(body.entries.map((entry) => entry.kind)).toEqual(["phase", "agent-message", "tool", "tool", "usage", "phase"]);
  expect(body.entries.find((entry) => entry.kind === "agent-message")?.text).toContain("notification path");
  expect(JSON.stringify(finishes[0]!.body)).toContain('"agentSessionId":"sess-shared"');
});

test("a silent workflow completes the same Run without spawning an Agent", async () => {
  const { d, spawns, finishes } = deps({
    runWorkflow: async (_source, prev) => ({
      ok: true,
      result: { state: { previous: prev, cursor: 3 }, agentCalls: [] },
      stdout: "",
      stderr: "",
    }),
  });
  await runKernelDelivery({
    ...KR,
    workflow: { format: "loopany-js-v1", source: "return { state: { cursor: 3 } };" },
    prevWorkflowState: { cursor: 2 },
  }, "https://srv.example", [], undefined, d);
  expect(spawns).toHaveLength(0);
  expect(finishes[0]!.body).toMatchObject({ command: { outcome: "done", workflow: { outcome: "silent", state: { previous: { cursor: 2 }, cursor: 3 } } } });
});

test("a real workflow subprocess receives prev and completes without spawning an Agent", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-kernel-workflow-"));
  try {
    const { d, spawns, finishes } = deps({ isDirectory: (candidate) => candidate === cwd, runWorkflow });
    await runKernelDelivery({
      ...KR,
      workdir: cwd,
      workflow: {
        format: "loopany-js-v1",
        source: "return { message: `cursor ${prev.cursor + 1}`, state: { cursor: prev.cursor + 1 } };",
      },
      prevWorkflowState: { cursor: 4 },
    }, "https://srv.example", [], undefined, d);

    expect(spawns).toHaveLength(0);
    expect(finishes[0]!.body).toMatchObject({
      command: {
        outcome: "done",
        workflow: { outcome: "direct", message: "cursor 5", state: { cursor: 5 } },
      },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an escalated workflow folds its signal into the CORE prompt and advances state", async () => {
  const { d, spawns, finishes } = deps({
    runWorkflow: async () => ({
      ok: true,
      result: { state: { cursor: 4 }, agentCalls: [{ message: "Review anomaly", data: { count: 7 } }] },
      stdout: "",
      stderr: "",
    }),
  });
  await runKernelDelivery({ ...KR, workflow: { format: "loopany-js-v1", source: "agent('x')" } }, "https://srv.example", [], undefined, d);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.args.join(" ")).toContain("Workflow signal");
  expect(spawns[0]!.args.join(" ")).toContain("Review anomaly");
  expect(finishes[0]!.body).toMatchObject({ command: { workflow: { outcome: "escalated", state: { cursor: 4 } } } });
});

test("a failed workflow falls back to the Agent without advancing state", async () => {
  const { d, spawns, finishes } = deps({
    runWorkflow: async () => ({ ok: false, error: "workflow exited with code 1", stdout: "", stderr: "boom" }),
  });
  await runKernelDelivery({ ...KR, workflow: { format: "loopany-js-v1", source: "throw new Error('boom')" } }, "https://srv.example", [], undefined, d);
  expect(spawns[0]!.args.join(" ")).toContain("Workflow pre-stage failed");
  expect(finishes[0]!.body).toMatchObject({ command: { outcome: "done", workflow: { outcome: "failed" } } });
  expect(JSON.stringify(finishes[0]!.body)).not.toContain('"state"');
});

test("the agent's OWN session id rides run-finish; the retry's session wins (fresh transcript)", async () => {
  // First attempt fails with session A; the retry succeeds with session B - the
  // reported id must name the transcript that produced the FINAL outcome.
  const sessions = ["sess-A", "sess-B"];
  let call = 0;
  const { d, finishes } = deps();
  d.run = async () => {
    const i = call++;
    return { code: i === 0 ? 1 : 0, agentSessionId: sessions[i] ?? null };
  };
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);
  const body = JSON.stringify(finishes[0]!.body);
  expect(body).toContain('"agentSessionId":"sess-B"');
  expect(body).toContain('"outcome":"done"');

  // No session captured (replay shim / non-claude stream): the field is ABSENT,
  // never null-noise on the wire.
  const plain = deps();
  await runKernelDelivery(KR, "https://srv.example", [], undefined, plain.d);
  expect(JSON.stringify(plain.finishes[0]!.body)).not.toContain("agentSessionId");
});

test("a MISSING workdir fails loud: no spawn, run-finish(failed) names the path", async () => {
  const { d, spawns, finishes } = deps({ isDirectory: () => false });
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);
  expect(spawns).toHaveLength(0);
  expect(JSON.stringify(finishes[0]!.body)).toContain("workdir does not exist on this machine: /work/superdesign");
});

test("a nonzero exit retries ONCE; a second failure reports failed", async () => {
  const { d, spawns, finishes } = deps({ codes: [1, 1] });
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);
  expect(spawns).toHaveLength(2);
  expect(JSON.stringify(finishes[0]!.body)).toContain("incl. one retry");

  const ok = deps({ codes: [1, 0] });
  await runKernelDelivery(KR, "https://srv.example", [], undefined, ok.d);
  expect(ok.spawns).toHaveLength(2);
  expect(JSON.stringify(ok.finishes[0]!.body)).toContain('"outcome":"done"');
});

test("a null workdir uses a scratch dir; an unknown agent fails without spawning", async () => {
  const { d, spawns } = deps();
  await runKernelDelivery({ ...KR, workdir: null }, "https://srv.example", [], undefined, d);
  expect(spawns[0]!.cwd).toBe("/tmp/scratch");

  const bad = deps();
  await runKernelDelivery({ ...KR, agent: "gemini" }, "https://srv.example", [], undefined, bad.d);
  expect(bad.spawns).toHaveLength(0);
  expect(JSON.stringify(bad.finishes[0]!.body)).toContain("unknown agent");
});

test("a workdir OUTSIDE the local LOOPANY_ROOTS jail fails loud without spawning", async () => {
  const { d, spawns, finishes } = deps();
  await runKernelDelivery(KR, "https://srv.example", ["/allowed"], undefined, d);
  expect(spawns).toHaveLength(0);
  expect(JSON.stringify(finishes[0]!.body)).toContain("outside this machine's allowed roots");

  // Inside the jail: runs normally.
  const ok = deps();
  await runKernelDelivery(KR, "https://srv.example", ["/work"], undefined, ok.d);
  expect(ok.spawns).toHaveLength(1);

  // A `..`-smuggled path that lexically starts inside but resolves outside is refused.
  const smuggle = deps();
  await runKernelDelivery(
    { ...KR, workdir: "/work/../etc" },
    "https://srv.example",
    ["/work"],
    undefined,
    smuggle.d,
  );
  expect(smuggle.spawns).toHaveLength(0);
  expect(JSON.stringify(smuggle.finishes[0]!.body)).toContain("outside this machine's allowed roots");

  // A null workdir (daemon-chosen scratch) is exempt from the jail, like production.
  const scratch = deps();
  await runKernelDelivery({ ...KR, workdir: null }, "https://srv.example", ["/allowed"], undefined, scratch.d);
  expect(scratch.spawns).toHaveLength(1);
  expect(scratch.spawns[0]!.cwd).toBe("/tmp/scratch");
});

test("the kernel shim dir is PREPENDED to the child PATH so `lk` resolves", async () => {
  const { d, spawns } = deps();
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);
  expect(spawns[0]!.env.PATH!.startsWith("/shim/kernel-bin:")).toBe(true);

  // No shim available: PATH untouched, the spawn still proceeds (global install).
  const bare = deps({ kernelBinDir: () => null });
  await runKernelDelivery(KR, "https://srv.example", [], undefined, bare.d);
  expect(bare.spawns).toHaveLength(1);
  expect(bare.spawns[0]!.env.PATH ?? "").not.toContain("/shim/kernel-bin");
});

test("ensureKernelBinDir pins both lk and loopany-kernel to the same absolute entry", () => {
  const dir = ensureKernelBinDir();
  // In the repo the workspace launcher always exists, so this resolves.
  expect(dir).toBeTruthy();
  const lkShim = fs.readFileSync(`${dir}/lk`, "utf8");
  const compatibilityShim = fs.readFileSync(`${dir}/loopany-kernel`, "utf8");
  expect(lkShim).toBe(compatibilityShim);
  expect(lkShim.startsWith("#!/bin/sh\n")).toBe(true);
  expect(lkShim).toContain(process.execPath); // absolute node - never PATH-dependent
  expect(lkShim).toContain('.mjs"'); // absolute entry path
  for (const name of ["lk", "loopany-kernel"]) {
    const mode = fs.statSync(`${dir}/${name}`).mode & 0o777;
    expect(mode & 0o111).not.toBe(0); // executable
  }
  expect(ensureKernelBinDir()).toBe(dir); // cached per process
});

test("a failed finish POST retries with backoff and eventually lands", async () => {
  const { d, finishes, sleeps } = deps({ finishFailures: 2 });
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);
  expect(finishes).toHaveLength(1); // landed on the 3rd attempt
  expect(sleeps).toEqual(FINISH_RETRY_DELAYS_MS.slice(0, 2));
  expect(JSON.stringify(finishes[0]!.body)).toContain('"outcome":"done"');
});

test("an exhausted finish ladder gives up without throwing (orphan reconcile settles it)", async () => {
  const { d, finishes, sleeps } = deps({ finishFailures: FINISH_RETRY_DELAYS_MS.length + 1 });
  await runKernelDelivery(KR, "https://srv.example", [], undefined, d);
  expect(finishes).toHaveLength(0);
  expect(sleeps).toEqual(FINISH_RETRY_DELAYS_MS);
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
