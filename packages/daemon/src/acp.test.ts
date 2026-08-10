import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  acpSessionName,
  buildCodexAcpEnsureSpawn,
  buildCodexAcpSpawn,
  costFromAcpResult,
  makeAcpStreamConsumer,
  resolveCodexBackend,
} from "./acp.js";

afterEach(() => {
  delete process.env.LOOPANY_ACPX_BIN;
  delete process.env.LOOPANY_CODEX_ACP_BIN;
});

describe("Codex ACP backend selection and spawn", () => {
  test("is opt-in and rejects a typo instead of silently changing transport", () => {
    expect(resolveCodexBackend(undefined)).toBe("native");
    expect(resolveCodexBackend("cli")).toBe("native");
    expect(resolveCodexBackend("ACP")).toBe("acp");
    expect(() => resolveCodexBackend("apc")).toThrow(/native or acp/);
  });

  test("uses pinned local JS entrypoints, strict JSON, unattended permissions, and a named session", () => {
    const spawn = buildCodexAcpSpawn({ prompt: "do it", sessionName: "loopany-run-1", model: "gpt-test" });
    expect(spawn.bin).toBe(process.execPath);
    expect(spawn.args[0]).toMatch(/acpx[/\\]dist[/\\]cli\.js$/);
    expect(spawn.args).toContain("--json-strict");
    expect(spawn.args).toContain("--approve-all");
    expect(spawn.args).toContain("--suppress-reads");
    expect(spawn.args[spawn.args.indexOf("--auth-policy") + 1]).toBe("skip");
    expect(spawn.args).toContain("loopany-run-1");
    expect(spawn.args).toContain("gpt-test");
    const agentCommand = spawn.args[spawn.args.indexOf("--agent") + 1];
    expect(agentCommand).toMatch(/codex-acp[/\\]dist[/\\]index\.js/);
    expect(spawn.args.at(-1)).toBe("do it");
  });

  test("builds the explicit named-session ensure required before a prompt", () => {
    process.env.LOOPANY_ACPX_BIN = "/opt/acpx";
    const spawn = buildCodexAcpEnsureSpawn({ sessionName: "loopany-run-1" });
    expect(spawn.args.slice(-4)).toEqual(["sessions", "ensure", "--name", "loopany-run-1"]);
  });

  test("supports explicit acpx and adapter command escape hatches", () => {
    process.env.LOOPANY_ACPX_BIN = "/opt/acpx";
    process.env.LOOPANY_CODEX_ACP_BIN = "/opt/codex-acp --profile loop";
    const spawn = buildCodexAcpSpawn({ prompt: "p", sessionName: "s" });
    expect(spawn.bin).toBe("/opt/acpx");
    expect(spawn.args[0]).toBe("--agent");
    expect(spawn.args[1]).toBe("/opt/codex-acp --profile loop");
  });

  test("makes a bounded acpx session name from an arbitrary run id", () => {
    expect(acpSessionName("run:one/two")).toBe("loopany-run-one-two");
    expect(acpSessionName("x".repeat(200)).length).toBeLessThanOrEqual(104);
  });
});

describe("Codex ACP JSON-RPC parser", () => {
  test("maps the real terminal usage shape, including cache and reasoning tokens", () => {
    expect(costFromAcpResult({
      stopReason: "end_turn",
      usage: { totalTokens: 120, inputTokens: 80, cachedReadTokens: 30, outputTokens: 10, thoughtTokens: 4 },
    })).toEqual({
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 10,
      cacheReadTokens: 30,
      reasoningTokens: 4,
      numTurns: 1,
    });
  });

  test("derives session, progress, trace, artifact, context, final text, and detailed usage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-acp-"));
    fs.writeFileSync(path.join(root, "changed.ts"), "old\n", "utf8");
    const progress: Array<{ step: number; label: string }> = [];
    try {
      const stream = makeAcpStreamConsumer((p) => progress.push(p), root);
      const events = [
        { jsonrpc: "2.0", id: 1, result: { sessionId: "thread-1" } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "Inspect" } } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "ing" } } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Edit changed.ts", kind: "edit", status: "in_progress", rawInput: { patch: "..." }, locations: [{ path: "changed.ts", line: 1 }] } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Edit changed.ts", kind: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "Updated changed.ts" } }], locations: [{ path: "changed.ts", line: 1 }] } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-2", title: "Editing files", kind: "edit", status: "in_progress", content: [{ type: "diff", oldText: null, newText: "new", path: path.join(root, "created.ts"), _meta: { kind: "add" } }] } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-2", status: "completed" } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "agent_message_chunk", messageId: "answer-1", content: { type: "text", text: "DO" }, _meta: { codex: { phase: "final_answer" } } } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "agent_message_chunk", messageId: "answer-1", content: { type: "text", text: "NE" }, _meta: { codex: { phase: "final_answer" } } } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "usage_update", used: 26673, size: 258400 } } },
        { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn", usage: { totalTokens: 26673, inputTokens: 16679, cachedReadTokens: 9984, outputTokens: 10, thoughtTokens: 0 } } },
      ];
      // Exercise chunk boundaries and the unterminated-last-line flush.
      const raw = events.map((event) => JSON.stringify(event)).join("\n");
      stream.feed(raw.slice(0, 137));
      stream.feed(raw.slice(137));
      const final = stream.result();

      expect(final.sessionId).toBe("thread-1");
      expect(final.stopReason).toBe("end_turn");
      expect(final.finalText).toBe("DONE");
      expect(final.cost).toEqual({
        contextTokens: 26673,
        contextWindow: 258400,
        totalTokens: 26673,
        inputTokens: 16679,
        outputTokens: 10,
        cacheReadTokens: 9984,
        reasoningTokens: 0,
        numTurns: 1,
      });
      expect(final.artifacts).toEqual([
        { path: "changed.ts", kind: "edited" },
        { path: "created.ts", kind: "created" },
      ]);
      expect(final.transcript).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: "Thinking: Inspecting" }),
        expect.objectContaining({ kind: "tool", name: "Edit changed.ts" }),
        expect.objectContaining({ kind: "result", text: "Updated changed.ts" }),
        expect.objectContaining({ kind: "text", text: "DONE" }),
      ]));
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces a JSON-RPC error without throwing on stray non-JSON", () => {
    const stream = makeAcpStreamConsumer(() => {}, process.cwd());
    stream.feed("adapter banner\n");
    stream.feed('{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"boom","data":{"message":"connection reset"}}}');
    expect(stream.result().error).toContain("boom");
  });
});
