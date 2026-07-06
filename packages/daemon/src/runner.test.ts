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

import { buildWorkflowFallbackTask, costFromResult, dateStamp, foldEscalation, makeStreamConsumer, runDelivery, type Delivery } from "./runner.js";

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

  test("composes with the server-sent STATIC trigger verbatim (task column removed → d.task IS the trigger)", () => {
    // The fallback embeds the delivery's `task` — which the server now composes as a
    // static trigger (read the task file, report-or-finish, + a Goal line for a closed
    // loop). So the trigger, including any Goal (finish line), survives into the fallback.
    const trigger =
      "[loop run · MRR loop]\n\nRun now. Read your task file at loopany/mrr/README.md, follow its `## Spec`.\nGoal (finish line): reach 100 paying users\nEnd the run with `loopany report` — or `loopany finish`.";
    const t = buildWorkflowFallbackTask(trigger, failure, "2026-07-01", "mrr");
    expect(t).toContain("loopany/mrr/README.md");
    expect(t).toContain("Goal (finish line): reach 100 paying users");
    expect(t).toContain("loopany finish");
  });
});

describe("buildWorkflowFallbackTask — SyntaxError (deterministic parse failure) branch", () => {
  // The incident: the workflow was authored in Claude Code Workflow tool syntax
  // (`export const meta`), which is illegal in the runner's async-arrow wrapper.
  const failure = {
    error: "workflow exited with code 1\nSyntaxError: Unexpected token 'export'",
    source: "export const meta = { name: 'x' };\nreturn { state: prev };",
  };
  const task = buildWorkflowFallbackTask("ORIGINAL TASK", failure, "2026-07-01", "cookie", "loop-abc");

  test("still tells the agent to complete the original task first", () => {
    expect(task).toContain("ORIGINAL TASK");
    expect(task).toMatch(/complete THIS run's original task/i);
  });
  test("treats it as a user-fix case, not a note-for-evolve case", () => {
    expect(task).toMatch(/SYNTAX ERROR/);
    expect(task).toMatch(/every future tick/i);
    expect(task).toMatch(/NO command to change the workflow/i);
    // The non-syntax "note it for evolve" closing must NOT appear.
    expect(task).not.toMatch(/note it briefly for the next evolve pass/i);
  });
  test("surfaces an owner prompt carrying the loop id to edit or clear the workflow", () => {
    expect(task).toContain("loopany edit loop-abc --workflow-file");
    expect(task).toMatch(/clear it/i);
    expect(task).toContain('{"workflow":""}');
  });
  test("names the export/module trap in the corrected-body guidance", () => {
    expect(task).toMatch(/NOT an ES module/);
    expect(task).toMatch(/export const meta/);
  });
  test("falls back to a placeholder loop id when none is passed", () => {
    const t = buildWorkflowFallbackTask("T", failure, "2026-07-01", "cookie");
    expect(t).toContain("loopany edit <loop-id> --workflow-file");
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

  test("the terminal result event's cost/usage fields survive into the final json", () => {
    const c = makeStreamConsumer(() => {});
    c.feed(
      '{"type":"result","is_error":false,"result":"done","session_id":"s","total_cost_usd":0.4235,"num_turns":12,"usage":{"input_tokens":120,"output_tokens":950,"cache_read_input_tokens":48000,"cache_creation_input_tokens":900}}\n',
    );
    const cost = costFromResult(c.result().json!);
    expect(cost).toEqual({
      usd: 0.4235,
      inputTokens: 120,
      outputTokens: 950,
      cacheReadTokens: 48000,
      cacheCreationTokens: 900,
      numTurns: 12,
    });
  });
});

describe("costFromResult", () => {
  test("returns undefined when the result event carried no cost fields (older claude)", () => {
    expect(costFromResult({ is_error: false, result: "ok" })).toBeUndefined();
  });

  test("drops non-numeric / negative values instead of forwarding garbage", () => {
    const cost = costFromResult({
      total_cost_usd: -1,
      num_turns: 3,
      usage: { input_tokens: "lots" as unknown as number, output_tokens: 10 },
    });
    expect(cost).toEqual({
      usd: undefined,
      inputTokens: undefined,
      outputTokens: 10,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      numTurns: 3,
    });
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

describe("runDelivery — the exec timeout is opt-in (unlimited by default)", () => {
  test("with LOOPANY_EXEC_TIMEOUT_MS unset, no timer is armed — a slow claude completes ok", async () => {
    // Fresh runner import so the module-load timeout read sees the env UNSET (0 ⇒ unlimited).
    vi.resetModules();
    delete process.env.LOOPANY_EXEC_TIMEOUT_MS;
    const { runDelivery: run } = await import("./runner.js");

    // A fake claude that sleeps well past the old default (and past the 1500ms override
    // used in the timeout test) before finishing cleanly. If a timer were armed by default
    // this would report a timeout; with no timer it reports a normal success.
    const bin = path.join(root, "slow-ok-claude.sh");
    fs.writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `echo '{"type":"system","session_id":"sess-unlimited"}'`,
        "sleep 2",
        `echo '{"type":"result","is_error":false,"subtype":"success","result":"delivered","session_id":"sess-unlimited"}'`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    process.env.LOOPANY_CLAUDE_BIN = bin;

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
    }
    const rep = reports.find((r) => r.runId === "run-1");
    expect(rep).toBeTruthy();
    expect(rep.ok).toBe(true);
    expect(rep.error).toBeUndefined();
  }, 30000);
});

/** A fake claude that records EVERY arg it was handed (one per line) to
 *  cwd/argv.txt, then emits a clean success — so a test can assert which flags the
 *  runner did (or did not) pass. */
function writeArgvClaude(): string {
  const p = path.join(root, "argv-claude.sh");
  fs.writeFileSync(
    p,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > argv.txt',
      `echo '{"type":"result","is_error":false,"subtype":"success","result":"delivered","session_id":"sess-args"}'`,
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(p, 0o755);
  return p;
}

describe("runDelivery — the system prompt file is skipped when empty (batches 1-2)", () => {
  test("an EMPTY systemPrompt → no sys file, no --append-system-prompt-file flag", async () => {
    process.env.LOOPANY_CLAUDE_BIN = writeArgvClaude();
    const runsDir = path.join(process.env.LOOPANY_HOME || path.join(os.homedir(), ".loopany"), "runs");
    await runDelivery(delivery({ systemPrompt: "", loop: { ...delivery().loop, workflow: null } }), "http://127.0.0.1:1/unused", []);
    const args = fs.readFileSync(path.join(workdir, "argv.txt"), "utf8");
    // The claude-only flag is gone — opens multi-agent execution (the task carries all).
    expect(args).not.toContain("--append-system-prompt-file");
    // …and no sys-<runId>.md was left behind (it was never written).
    expect(fs.existsSync(path.join(runsDir, "sys-run-1.md"))).toBe(false);
  }, 20000);

  test("a POPULATED systemPrompt (old server) still writes the sys file and passes the flag", async () => {
    process.env.LOOPANY_CLAUDE_BIN = writeArgvClaude();
    await runDelivery(delivery({ systemPrompt: "SYSTEM PROMPT BODY", loop: { ...delivery().loop, workflow: null } }), "http://127.0.0.1:1/unused", []);
    const args = fs.readFileSync(path.join(workdir, "argv.txt"), "utf8");
    // Back-compat: an old server that still populates systemPrompt keeps working.
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toMatch(/sys-run-1\.md/);
  }, 20000);
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

/** Local server that captures every report POST (report is fire-and-forget). */
function reportCapture(): { reports: any[]; start: () => Promise<string>; close: () => void } {
  const reports: any[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      reports.push(JSON.parse(body));
      res.end("{}");
    });
  });
  return {
    reports,
    start: async () => {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    close: () => srv.close(),
  };
}

describe("runDelivery — an evolve run's finalText reaches the report", () => {
  test("finalText rides along for role=evolve (the server's message fallback needs it)", async () => {
    const bin = path.join(root, "evolve-claude.sh");
    fs.writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `echo '{"type":"result","is_error":false,"subtype":"success","result":"sharpened the Spec; no workflow change","session_id":"sess-ev"}'`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    process.env.LOOPANY_CLAUDE_BIN = bin;

    const cap = reportCapture();
    const url = await cap.start();
    try {
      await runDelivery(delivery({ role: "evolve", loop: { ...delivery().loop, workflow: null } }), url, []);
    } finally {
      cap.close();
    }
    const rep = cap.reports.find((r) => r.runId === "run-1");
    expect(rep).toBeTruthy();
    expect(rep.ok).toBe(true);
    expect(rep.outcome).toBe("evolve");
    // Pre-fix: undefined (deliberately dropped) — every evolve run row had message null.
    expect(rep.finalText).toBe("sharpened the Spec; no workflow change");
  }, 20000);
});

describe("runDelivery — a non-zero exit with a clean result never records 'success' as the error", () => {
  test("subtype 'success' + exit 1 → the exit code is the error, not the subtype", async () => {
    const bin = path.join(root, "dying-claude.sh");
    fs.writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `echo '{"type":"result","is_error":false,"subtype":"success","result":"done","session_id":"sess-die"}'`,
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    process.env.LOOPANY_CLAUDE_BIN = bin;

    const cap = reportCapture();
    const url = await cap.start();
    try {
      await runDelivery(delivery({ loop: { ...delivery().loop, workflow: null } }), url, []);
    } finally {
      cap.close();
    }
    const rep = cap.reports.find((r) => r.runId === "run-1");
    expect(rep).toBeTruthy();
    expect(rep.ok).toBe(false);
    // Pre-fix: error was literally "success" (the result event's subtype).
    expect(rep.error).toBe("claude exited with code 1");
  }, 20000);

  test("an informative subtype still wins over the exit code", async () => {
    const bin = path.join(root, "maxturns-claude.sh");
    fs.writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `echo '{"type":"result","is_error":true,"subtype":"error_max_turns","result":"","session_id":"sess-mt"}'`,
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    process.env.LOOPANY_CLAUDE_BIN = bin;

    const cap = reportCapture();
    const url = await cap.start();
    try {
      await runDelivery(delivery({ loop: { ...delivery().loop, workflow: null } }), url, []);
    } finally {
      cap.close();
    }
    const rep = cap.reports.find((r) => r.runId === "run-1");
    expect(rep).toBeTruthy();
    expect(rep.ok).toBe(false);
    expect(rep.error).toBe("error_max_turns");
  }, 20000);
});
