/**
 * Workflow sandbox — the bare-node subprocess gate. Proves the injected surface:
 * `prev`, `agent()`, and the new `tools.call()` MCP bridge. The bridge is pointed at
 * a FIXTURE module (via LOOPANY_MCP_BRIDGE) so nothing hits mcporter or the network —
 * this tests the WIRING (args in, result out, errors surfaced), while mcp-bridge.test.ts
 * covers the bridge's own logic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runWorkflow } from "./workflow.js";

let dir: string;
let cwd: string;

/** Write a fixture bridge exporting a `callTool` with the given body; return its file URL. */
function writeFixtureBridge(body: string): string {
  const p = path.join(dir, `bridge-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(p, `export async function callTool(name, args) {\n${body}\n}\n`, "utf8");
  return pathToFileURL(p).href;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-wf-test-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-wf-cwd-"));
});
afterEach(() => {
  delete process.env.LOOPANY_MCP_BRIDGE;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("existing sandbox contract stays green", () => {
  test("pure workflow returns a direct message", async () => {
    const r = await runWorkflow(`return { message: "hi", state: { n: 1 } };`, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.message).toBe("hi");
    expect(r.result?.state).toEqual({ n: 1 });
    expect(r.result?.agentCalls).toEqual([]);
  });

  test("agent() escalation is captured; prev is threaded", async () => {
    const r = await runWorkflow(`agent("look", { from: prev }); return {};`, { seed: 7 }, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.agentCalls).toEqual([{ message: "look", data: { from: { seed: 7 } } }]);
  });

  test("silent tick (no message, no agent)", async () => {
    const r = await runWorkflow(`return;`, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.message).toBeUndefined();
    expect(r.result?.agentCalls).toEqual([]);
  });

  test("workflow can set status (new|resolved|nothing-new) alongside message/state", async () => {
    const r = await runWorkflow(`return { message: "ok", state: { n: 1 }, status: "resolved" };`, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.status).toBe("resolved");
  });

  test("omitting status leaves it undefined (backward compatible with existing workflows)", async () => {
    const r = await runWorkflow(`return { message: "ok" };`, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.status).toBeUndefined();
  });

  test("an invalid status value fails the workflow with a clear error", async () => {
    const r = await runWorkflow(`return { message: "ok", status: "bogus" };`, null, cwd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status.*new\|resolved\|nothing-new/);
  });
});

describe("subprocess env allowlist", () => {
  test("server-supplied workflow JS cannot read shell secrets; LOOPANY_WORKFLOW_* rides along", async () => {
    process.env.MY_FAKE_SECRET = "leak-me-not";
    process.env.LOOPANY_WORKFLOW_TOOL_RESULT_CAP = "12345";
    try {
      const r = await runWorkflow(
        `return { message: (process.env.MY_FAKE_SECRET ?? "absent") + "|" + (process.env.LOOPANY_WORKFLOW_TOOL_RESULT_CAP ?? "missing") };`,
        null,
        cwd,
      );
      expect(r.ok).toBe(true);
      expect(r.result?.message).toBe("absent|12345");
    } finally {
      delete process.env.MY_FAKE_SECRET;
      delete process.env.LOOPANY_WORKFLOW_TOOL_RESULT_CAP;
    }
  });

  test("LOOPANY_WORKFLOW_ENV opts named keys through (MCP configs resolve ${VAR} creds from this env)", async () => {
    process.env.MY_FAKE_TOKEN = "tok-1";
    process.env.MY_OTHER_SECRET = "still-hidden";
    process.env.LOOPANY_WORKFLOW_ENV = " MY_FAKE_TOKEN , MISSING_KEY ";
    try {
      const r = await runWorkflow(
        `return { message: (process.env.MY_FAKE_TOKEN ?? "absent") + "|" + (process.env.MY_OTHER_SECRET ?? "absent") };`,
        null,
        cwd,
      );
      expect(r.ok).toBe(true);
      // Only the named key rides along; everything else stays stripped.
      expect(r.result?.message).toBe("tok-1|absent");
    } finally {
      delete process.env.MY_FAKE_TOKEN;
      delete process.env.MY_OTHER_SECRET;
      delete process.env.LOOPANY_WORKFLOW_ENV;
    }
  });
});

describe("tools.call wiring (fixture bridge)", () => {
  test("tools.call is injected; args flow in and the result flows out", async () => {
    // Fixture echoes the call back so the workflow can assert both directions.
    process.env.LOOPANY_MCP_BRIDGE = writeFixtureBridge(
      `return { text: "called " + name, data: { echoedArgs: args } };`,
    );
    const body = `
      const res = await tools.call("posthog.projects-get", { limit: 3 });
      return { message: res.text, state: res.data };
    `;
    const r = await runWorkflow(body, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.message).toBe("called posthog.projects-get");
    expect(r.result?.state).toEqual({ echoedArgs: { limit: 3 } });
  });

  test("prepared data can be handed to agent() (the intended pattern)", async () => {
    process.env.LOOPANY_MCP_BRIDGE = writeFixtureBridge(
      `return { text: "3 rows", data: [{ id: 1 }, { id: 2 }, { id: 3 }] };`,
    );
    const body = `
      const res = await tools.call("posthog.insight-query", {});
      agent("summarize these rows", res.data);
      return {};
    `;
    const r = await runWorkflow(body, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.agentCalls).toEqual([
      { message: "summarize these rows", data: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ]);
  });

  test("a failed tools.call fails the workflow (→ runner falls back to the agent)", async () => {
    process.env.LOOPANY_MCP_BRIDGE = writeFixtureBridge(
      `throw new Error('tools.call: MCP server "posthog" is not configured on this machine');`,
    );
    const body = `await tools.call("posthog.projects-get", {}); return { message: "unreached" };`;
    const r = await runWorkflow(body, null, cwd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/workflow exited with code/);
    expect(r.stderr).toMatch(/not configured on this machine/);
  });

  test("a workflow that never calls tools.call never loads the bridge (no MCP cost)", async () => {
    // Point at a bridge that would throw on import — proving lazy loading.
    const bad = path.join(dir, "explode.mjs");
    fs.writeFileSync(bad, `throw new Error("bridge import should not happen");`, "utf8");
    process.env.LOOPANY_MCP_BRIDGE = pathToFileURL(bad).href;
    const r = await runWorkflow(`return { message: "no tools here" };`, null, cwd);
    expect(r.ok).toBe(true);
    expect(r.result?.message).toBe("no tools here");
  });
});
