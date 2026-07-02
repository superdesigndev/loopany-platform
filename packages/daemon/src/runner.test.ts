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
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildWorkflowFallbackTask, dateStamp, foldEscalation, makeStreamConsumer, runDelivery, type Delivery } from "./runner.js";

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
  test("explains the allowlisted env + the LOOPANY_WORKFLOW_ENV pass-through knob", () => {
    // The subprocess env is stripped, so an env-resolved MCP credential fails
    // there while working in the user's shell — the agent must know the knob
    // instead of telling the user to set an env var the daemon strips anyway.
    expect(task).toContain("ALLOWLISTED env");
    expect(task).toContain("LOOPANY_WORKFLOW_ENV");
  });
});

describe("foldEscalation", () => {
  test("folds message + pretty-printed data into the task text", () => {
    const s = foldEscalation([{ message: "look at this", data: { a: 1 } }]);
    expect(s).toContain("look at this");
    expect(s).toContain('"a": 1');
  });

  test("caps a huge data payload with a truncation marker (argv E2BIG guard)", () => {
    const s = foldEscalation([{ message: "big", data: { rows: "x".repeat(200 * 1024) } }]);
    expect(s.length).toBeLessThan(70 * 1024); // well under the ~256KB OS argv limit
    expect(s).toContain("[truncated — agent() data exceeded 64KB");
  });

  test("a message-only call folds without a data block", () => {
    expect(foldEscalation([{ message: "just a note" }])).toBe("just a note");
  });
});

describe("makeStreamConsumer", () => {
  test("flushes a final UNTERMINATED line at result() (no trailing newline)", () => {
    const c = makeStreamConsumer(() => {});
    c.feed('{"type":"result","is_error":false,"subtype":"success","result":"done","session_id":"sess-1"}'); // no \n
    const final = c.result();
    expect(final.json?.result).toBe("done");
    expect(final.sessionId).toBe("sess-1");
  });

  test("newline-terminated lines still parse (and result() is a no-op flush)", () => {
    const c = makeStreamConsumer(() => {});
    c.feed('{"type":"result","is_error":false,"result":"ok","session_id":"sess-2"}\n');
    expect(c.result().json?.result).toBe("ok");
    expect(c.result().sessionId).toBe("sess-2"); // idempotent
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

describe("runDelivery — a timed-out run keeps its session pointer", () => {
  test("sessionId is reported even when claude times out (transcript recovery stays possible)", async () => {
    // Fresh runner import so a tiny LOOPANY_EXEC_TIMEOUT_MS (read at module load) applies.
    vi.resetModules();
    process.env.LOOPANY_EXEC_TIMEOUT_MS = "1500";
    const { runDelivery: run } = await import("./runner.js");

    // A fake claude that streams its session id early, then hangs past the timeout.
    const bin = path.join(root, "slow-claude.sh");
    fs.writeFileSync(bin, ["#!/bin/sh", `echo '{"type":"system","session_id":"sess-slow"}'`, "sleep 30", ""].join("\n"), "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.LOOPANY_CLAUDE_BIN = bin;

    // Capture the report POST with a real local server (report is fire-and-forget).
    const reports: any[] = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        reports.push(JSON.parse(body));
        res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      await run(delivery({ loop: { ...delivery().loop, workflow: null } }), `http://127.0.0.1:${port}`, []);
    } finally {
      srv.close();
      delete process.env.LOOPANY_EXEC_TIMEOUT_MS;
    }
    const rep = reports.find((r) => r.runId === "run-1");
    expect(rep).toBeTruthy();
    expect(rep.ok).toBe(false);
    expect(rep.error).toMatch(/timed out/);
    expect(rep.sessionId).toBe("sess-slow"); // pre-fix: undefined — the debug pointer was lost
  }, 30000);
});

describe("runDelivery — the local LOOPANY_ROOTS jail always applies", () => {
  test("server-sent roots cannot WIDEN the jail to admit an out-of-jail workdir (claude never runs)", async () => {
    process.env.LOOPANY_CLAUDE_BIN = writeFakeClaude();
    const jail = path.join(root, "jail");
    fs.mkdirSync(jail, { recursive: true });
    // The delivery's workdir sits OUTSIDE the local jail; the server "helpfully"
    // sends roots that would allow it. Pre-fix the server roots won — now the
    // local jail rejects the workdir and the run reports an error instead.
    await runDelivery(
      delivery({ roots: [workdir], loop: { ...delivery().loop, workflow: null } }),
      "http://127.0.0.1:1/unused",
      [jail],
    );
    expect(fs.existsSync(path.join(workdir, "captured-task.txt"))).toBe(false);
  }, 20000);

  test("a workdir inside the local jail still runs (server roots narrow, not break)", async () => {
    process.env.LOOPANY_CLAUDE_BIN = writeFakeClaude();
    await runDelivery(
      delivery({ roots: [workdir], loop: { ...delivery().loop, workflow: null } }),
      "http://127.0.0.1:1/unused",
      [root], // local jail covers the workdir; server root narrows within it
    );
    expect(fs.existsSync(path.join(workdir, "captured-task.txt"))).toBe(true);
  }, 20000);
});
