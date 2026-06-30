/**
 * Agent recording at `loopany new`: the env-fingerprint detector and the
 * resolution precedence (measured env > declared --agent/config > undefined).
 * Pure functions, no network — they decide the `agent` field the create POST
 * carries (or omits, letting the server default it to claude-code).
 */
import { describe, expect, test } from "vitest";

import { coerceAgent, detectAgentFromEnv, resolveAgent } from "./create.js";

describe("detectAgentFromEnv", () => {
  test("fingerprints Claude Code from CLAUDECODE (verified live)", () => {
    expect(detectAgentFromEnv({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectAgentFromEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("claude-code");
  });

  test("fingerprints Codex from its sandbox env (per current Codex CLI docs)", () => {
    expect(detectAgentFromEnv({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectAgentFromEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe("codex");
  });

  test("ignores CODEX_COMPANION_* (a Claude Code session can export it — would misattribute)", () => {
    expect(detectAgentFromEnv({ CODEX_COMPANION_SESSION_ID: "abc" })).toBeNull();
  });

  test("returns null when no host marker is present (undetectable → caller falls back)", () => {
    expect(detectAgentFromEnv({ PATH: "/usr/bin" })).toBeNull();
  });

  test("Claude Code wins when both markers are present (its session is the real host)", () => {
    expect(detectAgentFromEnv({ CLAUDECODE: "1", CODEX_SANDBOX: "seatbelt" })).toBe("claude-code");
  });
});

describe("coerceAgent", () => {
  test("passes through known agents, rejects everything else", () => {
    expect(coerceAgent("claude-code")).toBe("claude-code");
    expect(coerceAgent("codex")).toBe("codex");
    expect(coerceAgent("unknown")).toBeNull();
    expect(coerceAgent("")).toBeNull();
    expect(coerceAgent(undefined)).toBeNull();
  });
});

describe("resolveAgent (precedence: measured > declared > undefined)", () => {
  test("a measured host overrides a conflicting declaration (can't be fooled)", () => {
    // Dialog/skill said codex, but we were pasted into a Claude Code session.
    expect(resolveAgent({ CLAUDECODE: "1" }, "codex")).toBe("claude-code");
  });

  test("falls back to the declared value when the env is undetectable", () => {
    expect(resolveAgent({ PATH: "/usr/bin" }, "codex")).toBe("codex");
    expect(resolveAgent({ PATH: "/usr/bin" }, "claude-code")).toBe("claude-code");
  });

  test("returns undefined when neither measured nor declared (server defaults it)", () => {
    expect(resolveAgent({ PATH: "/usr/bin" }, undefined)).toBeUndefined();
    expect(resolveAgent({ PATH: "/usr/bin" }, "")).toBeUndefined();
    expect(resolveAgent({ PATH: "/usr/bin" }, "garbage")).toBeUndefined();
  });
});
