/**
 * MCP bridge (the JS API behind workflow `tools.call`). Pure helpers + the callTool
 * path with an injected fake runtime — no mcporter, no network. Covers: name parsing,
 * arg/result caps, result shaping, and the clear-error contract for missing
 * server / tool / auth / runtime.
 */
import { afterEach, describe, expect, test } from "vitest";

import {
  callTool,
  capArgs,
  classifyCallError,
  closeRuntime,
  extractText,
  parseToolName,
  shapeResult,
} from "./mcp-bridge.mjs";

const CAP_ENVS = [
  "ADSCAILE_WORKFLOW_TOOL_ARGS_CAP",
  "ADSCAILE_WORKFLOW_TOOL_RESULT_CAP",
  "ADSCAILE_WORKFLOW_TOOL_TIMEOUT_SECONDS",
];
afterEach(() => {
  for (const k of CAP_ENVS) delete process.env[k];
});

/** A fake mcporter Runtime: callTool resolves `impl(server,tool,opts)` or throws it. */
function fakeRuntime(impl: (server: string, tool: string, opts: any) => unknown) {
  return {
    async callTool(server: string, tool: string, opts: any) {
      return impl(server, tool, opts);
    },
  };
}
const textResult = (text: string, extra: object = {}) => ({ content: [{ type: "text", text }], ...extra });

describe("parseToolName", () => {
  test("splits server.tool on the first dot", () => {
    expect(parseToolName("posthog.projects-get")).toEqual({ server: "posthog", tool: "projects-get" });
  });
  test("keeps dots inside the tool name (split on FIRST dot only)", () => {
    expect(parseToolName("srv.a.b.c")).toEqual({ server: "srv", tool: "a.b.c" });
  });
  test("rejects a name without a server.tool shape", () => {
    expect(() => parseToolName("projects-get")).toThrow(/server\.tool/);
    expect(() => parseToolName(".tool")).toThrow(/server\.tool/);
    expect(() => parseToolName("server.")).toThrow(/server\.tool/);
    expect(() => parseToolName("")).toThrow(/non-empty string/);
    // @ts-expect-error — non-string input
    expect(() => parseToolName(42)).toThrow(/non-empty string/);
  });
});

describe("capArgs", () => {
  test("passes through small args (and defaults undefined → {})", () => {
    expect(capArgs("s", "t", { a: 1 })).toEqual({ a: 1 });
    expect(capArgs("s", "t", undefined)).toEqual({});
  });
  test("throws a clear, specific error when args exceed the cap", () => {
    process.env.ADSCAILE_WORKFLOW_TOOL_ARGS_CAP = "50";
    expect(() => capArgs("posthog", "insight-query", { q: "x".repeat(200) })).toThrow(
      /posthog\.insight-query.*args too large.*ADSCAILE_WORKFLOW_TOOL_ARGS_CAP/,
    );
  });
  test("cap is env-overridable upward", () => {
    process.env.ADSCAILE_WORKFLOW_TOOL_ARGS_CAP = "100000";
    expect(() => capArgs("s", "t", { q: "x".repeat(2000) })).not.toThrow();
  });
});

describe("extractText / shapeResult", () => {
  test("flattens MCP text content", () => {
    expect(extractText(textResult("hello\nworld"))).toBe("hello\nworld");
  });
  test("shapeResult parses a JSON text body into data", () => {
    const r = shapeResult(textResult('{"count": 3}'));
    expect(r.text).toBe('{"count": 3}');
    expect(r.data).toEqual({ count: 3 });
  });
  test("shapeResult prefers structuredContent when present", () => {
    const r = shapeResult({ content: [{ type: "text", text: "ignored" }], structuredContent: { ok: true } });
    expect(r.data).toEqual({ ok: true });
  });
  test("non-JSON text yields null data", () => {
    const r = shapeResult(textResult("just prose"));
    expect(r.data).toBeNull();
  });
  test("caps a runaway result text and marks it truncated", () => {
    process.env.ADSCAILE_WORKFLOW_TOOL_RESULT_CAP = "20";
    const r = shapeResult(textResult("x".repeat(500)));
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/truncated/);
    expect(r.text.length).toBeLessThan(200);
    expect(r.data).toBeNull(); // truncated → don't try to parse partial JSON
  });
  test("drops oversized structured data rather than blowing the cap", () => {
    process.env.ADSCAILE_WORKFLOW_TOOL_RESULT_CAP = "40";
    const big = { items: Array.from({ length: 100 }, (_, i) => ({ i })) };
    const r = shapeResult({ content: [{ type: "text", text: "short" }], structuredContent: big });
    expect(r.data).toBeNull();
    expect(r.truncated).toBe(true);
  });
});

describe("classifyCallError", () => {
  test("missing server → 'not configured'", () => {
    expect(classifyCallError("foo", "t", "Unknown MCP server 'foo'.")).toMatch(/not configured/);
  });
  test("401 → auth required (and never interactive)", () => {
    expect(classifyCallError("posthog", "t", "SSE error: Non-200 status code (401)")).toMatch(
      /authentication required or expired.*re-authorize/,
    );
  });
  test("timeout → timed out", () => {
    expect(classifyCallError("posthog", "t", "request timed out")).toMatch(/timed out/);
  });
});

describe("callTool (fake runtime — no network)", () => {
  test("returns shaped { text, data } on success", async () => {
    const rt = fakeRuntime(() => textResult('{"projects": 2}'));
    const out = await callTool("posthog.projects-get", {}, { makeRuntime: () => rt });
    expect(out.data).toEqual({ projects: 2 });
    expect(out.text).toContain("projects");
  });

  test("passes args through and forces disableOAuth (headless)", async () => {
    let seen: any;
    const rt = fakeRuntime((_s, _t, opts) => {
      seen = opts;
      return textResult("ok");
    });
    await callTool("posthog.insight-query", { limit: 5 }, { makeRuntime: () => rt });
    expect(seen.args).toEqual({ limit: 5 });
    expect(seen.disableOAuth).toBe(true);
    expect(typeof seen.timeoutMs).toBe("number");
  });

  test("throws a clear error when the tool returns isError (missing/failed tool)", async () => {
    const rt = fakeRuntime(() => textResult("Tool bogus not found", { isError: true }));
    await expect(callTool("posthog.bogus", {}, { makeRuntime: () => rt })).rejects.toThrow(
      /MCP tool "posthog\.bogus" returned an error.*Tool bogus not found/,
    );
  });

  test("classifies a thrown missing-server error", async () => {
    const rt = fakeRuntime(() => {
      throw new Error("Unknown MCP server 'nope'.");
    });
    await expect(callTool("nope.x", {}, { makeRuntime: () => rt })).rejects.toThrow(/not configured/);
  });

  test("classifies a thrown auth (401) error", async () => {
    const rt = fakeRuntime(() => {
      throw new Error("SSE error: Non-200 status code (401)");
    });
    await expect(callTool("posthog.projects-get", {}, { makeRuntime: () => rt })).rejects.toThrow(
      /authentication required or expired/,
    );
  });

  test("surfaces a runtime that cannot be created", async () => {
    await expect(
      callTool("posthog.x", {}, {
        makeRuntime: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  test("closeRuntime is a no-op (never throws) when no runtime was created", async () => {
    await expect(closeRuntime()).resolves.toBeUndefined();
  });

  test("rejects oversized args before any runtime call", async () => {
    process.env.ADSCAILE_WORKFLOW_TOOL_ARGS_CAP = "10";
    let called = false;
    const rt = fakeRuntime(() => {
      called = true;
      return textResult("ok");
    });
    await expect(callTool("posthog.x", { big: "y".repeat(100) }, { makeRuntime: () => rt })).rejects.toThrow(
      /args too large/,
    );
    expect(called).toBe(false);
  });
});
