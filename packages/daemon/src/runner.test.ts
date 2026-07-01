/**
 * Runner — the workflow-failure → agent-fallback path (phase 1) plus the pure
 * fallback-task/date helpers.
 *
 * The integration test spawns a FAKE `claude` (LOOPANY_CLAUDE_BIN) that captures the
 * task it was handed, and a FAILING MCP bridge fixture (LOOPANY_MCP_BRIDGE) so a
 * `tools.call` in the workflow throws. It proves a failed workflow does NOT just report
 * a failed run — it runs the agent with a fallback task carrying the original task, the
 * workflow error, the workflow source, the dated setup file, and the copy-paste fix prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildWorkflowFallbackTask, dateStamp, runDelivery, type Delivery } from "./runner.js";

describe("dateStamp", () => {
  test("formats YYYY-MM-DD (UTC)", () => {
    expect(dateStamp(new Date("2026-07-01T23:59:00Z"))).toBe("2026-07-01");
  });
});

describe("buildWorkflowFallbackTask", () => {
  const failure = { error: "tools.call: MCP server \"posthog\" is not configured", source: "await tools.call('posthog.x', {})" };
  const task = buildWorkflowFallbackTask("ORIGINAL TASK: do the thing", failure, "2026-07-01", "cookie-report");

  test("carries the original task, the workflow error, and the workflow source", () => {
    expect(task).toContain("ORIGINAL TASK: do the thing");
    expect(task).toContain("not configured");
    expect(task).toContain("await tools.call('posthog.x', {})");
  });
  test("tells the agent to complete the original task FIRST, then diagnose", () => {
    expect(task).toMatch(/complete THIS run's original task/i);
    expect(task).toMatch(/diagnose why the workflow failed/i);
  });
  test("names a dated setup file and a copy-paste fix prompt for config-needed fixes", () => {
    expect(task).toContain("workflow-setup-2026-07-01.md");
    expect(task).toContain("fix workflow issue in loopany/cookie-report/workflow-setup-2026-07-01.md");
  });
});

// ---- fallback path integration ----

let root: string;
let workdir: string;

/** A fake `claude` that records the `-p` task (argv $2) to cwd/captured-task.txt and
 *  emits one stream-json result line so the runner parses a clean success. */
function writeFakeClaude(): string {
  const p = path.join(root, "fake-claude.sh");
  fs.writeFileSync(
    p,
    [
      "#!/bin/sh",
      // args are: -p <task> --output-format stream-json ...
      'printf "%s" "$2" > captured-task.txt',
      `echo '{"type":"result","is_error":false,"subtype":"success","result":"delivered","session_id":"sess-test"}'`,
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(p, 0o755);
  return p;
}

function writeFailingBridge(): string {
  const p = path.join(root, "failing-bridge.mjs");
  fs.writeFileSync(
    p,
    `export async function callTool(name) { throw new Error('tools.call: MCP server "posthog" is not configured on this machine'); }`,
    "utf8",
  );
  return pathToFileURL(p).href;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-runner-"));
  workdir = path.join(root, "work");
  fs.mkdirSync(workdir, { recursive: true });
});
afterEach(() => {
  delete process.env.LOOPANY_CLAUDE_BIN;
  delete process.env.LOOPANY_MCP_BRIDGE;
  fs.rmSync(root, { recursive: true, force: true });
});

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    runId: "run-1",
    runToken: "tok-1",
    role: "exec",
    loop: {
      id: "loop-1",
      name: "cookie-report",
      workdir,
      taskFile: null,
      workflow: `await tools.call("posthog.projects-get", {}); return { message: "should not reach" };`,
      model: null,
      allowControl: false,
    },
    prevState: null,
    systemPrompt: "SYS",
    task: "ORIGINAL TASK: produce the daily report",
    ...overrides,
  };
}

describe("runDelivery — workflow failure falls back to the agent", () => {
  test("a failing tools.call routes to claude with the fallback task (not a failed run)", async () => {
    process.env.LOOPANY_CLAUDE_BIN = writeFakeClaude();
    process.env.LOOPANY_MCP_BRIDGE = writeFailingBridge();

    // serverUrl is bogus — report() is best-effort and swallows the fetch failure.
    await runDelivery(delivery(), "http://127.0.0.1:1/unused", []);

    const captured = fs.readFileSync(path.join(workdir, "captured-task.txt"), "utf8");
    // Original task still asked of the agent (loop delivers this tick)…
    expect(captured).toContain("ORIGINAL TASK: produce the daily report");
    // …plus the workflow failure diagnosis context.
    expect(captured).toContain("not configured on this machine");
    expect(captured).toContain('tools.call("posthog.projects-get"'); // the workflow source
    expect(captured).toMatch(/workflow-setup-\d{4}-\d{2}-\d{2}\.md/);
    expect(captured).toContain("fix workflow issue in loopany/cookie-report/");
  }, 20000);

  test("a healthy pure workflow still reports directly without invoking claude", async () => {
    // If claude WERE invoked it would write captured-task.txt; assert it never does.
    process.env.LOOPANY_CLAUDE_BIN = writeFakeClaude();
    await runDelivery(
      delivery({ loop: { ...delivery().loop, workflow: `return { message: "all good" };` } }),
      "http://127.0.0.1:1/unused",
      [],
    );
    expect(fs.existsSync(path.join(workdir, "captured-task.txt"))).toBe(false);
  }, 20000);
});
