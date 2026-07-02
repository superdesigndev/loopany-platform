/**
 * Agent recording at `loopany new`: the env-fingerprint detector and the
 * resolution precedence (measured env > declared --agent/config > undefined).
 * Pure functions, no network — they decide the `agent` field the create POST
 * carries (or omits, letting the server default it to claude-code).
 *
 * Plus the skill-install trigger at create: where the workdir resolves and that
 * the install fires only after a confirmed create, never blocking it (both with
 * the fetch + installer seams injected, so nothing hits the network or spawns npx).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LOOPANY_DIR } from "./config.js";
import { coerceAgent, cronLooksValid, detectAgentFromEnv, resolveAgent, resolveLoopWorkdir, runCreate } from "./create.js";
import type { InstallOpts, InstallOutcome } from "./skill-install.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errResponse = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

/** Write a throwaway config file and return its path. */
function tmpConfig(cfg: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-create-"));
  const f = path.join(dir, "loop.json");
  fs.writeFileSync(f, JSON.stringify(cfg));
  return f;
}

/** An absolute path under a fresh temp dir that does NOT yet exist — so a test can
 *  prove the installer's cwd is created before the install spawns (the ENOENT fix). */
function tmpWorkdir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-workdir-"));
  return path.join(base, "loop", "run");
}

describe("cronLooksValid (local pre-check only — the server/croner is the sole validator)", () => {
  test("accepts the 5-field, 6-field (seconds), and @-shortcut forms croner supports", () => {
    expect(cronLooksValid("0 8 * * *")).toBe(true);
    expect(cronLooksValid("0 0 8 * * *")).toBe(true);
    expect(cronLooksValid("@daily")).toBe(true);
    expect(cronLooksValid("  @hourly  ")).toBe(true);
  });

  test("rejects only the obviously-wrong shapes", () => {
    expect(cronLooksValid("")).toBe(false);
    expect(cronLooksValid("   ")).toBe(false);
    expect(cronLooksValid("* *")).toBe(false);
    expect(cronLooksValid("1 2 3 4 5 6 7")).toBe(false);
    expect(cronLooksValid(42)).toBe(false);
    expect(cronLooksValid(undefined)).toBe(false);
  });
});

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

describe("resolveLoopWorkdir (where the skill installs at create)", () => {
  test("an explicit workdir is used verbatim (made absolute)", () => {
    expect(resolveLoopWorkdir("/srv/loops/cookie", "loop-1")).toBe(path.resolve("/srv/loops/cookie"));
  });

  test("a ~/ workdir expands to the home dir", () => {
    expect(resolveLoopWorkdir("~/loops/cookie", "loop-1")).toBe(path.join(os.homedir(), "loops/cookie"));
  });

  test("no workdir → the per-loop daemon scratch dir, never process.cwd()", () => {
    const expected = path.join(LOOPANY_DIR, "work", "loop-xyz");
    expect(resolveLoopWorkdir(undefined, "loop-xyz")).toBe(expected);
    expect(resolveLoopWorkdir("   ", "loop-xyz")).toBe(expected);
    expect(resolveLoopWorkdir(undefined, "loop-xyz")).not.toBe(process.cwd());
  });

  test("no workdir AND no loopId → \"\" (never collapses to the shared scratch parent)", () => {
    expect(resolveLoopWorkdir(undefined, "")).toBe("");
    expect(resolveLoopWorkdir("   ", "  ")).toBe("");
    expect(resolveLoopWorkdir(undefined, "")).not.toBe(path.join(LOOPANY_DIR, "work"));
  });
});

describe("runCreate — skill install fires only after a confirmed create, never blocks it", () => {
  const prevToken = process.env.LOOPANY_TOKEN;
  beforeEach(() => {
    process.env.LOOPANY_TOKEN = "dk_test"; // satisfy the "machine connected" precheck without touching disk
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.LOOPANY_TOKEN;
    else process.env.LOOPANY_TOKEN = prevToken;
  });

  test("a successful create creates the (not-yet-existing) workdir and installs there (project-level)", async () => {
    const workdir = tmpWorkdir(); // nested + absent → proves the dir is created before install
    const cfg = tmpConfig({ cron: "0 8 * * *", task: "report", workdir });
    const installed: InstallOpts[] = [];
    const installer = async (opts: InstallOpts): Promise<InstallOutcome> => {
      installed.push(opts);
      return { ok: true, line: "loopany skill: installed" };
    };
    const code = await runCreate(["--config", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie" }),
      installer,
      stdout: () => {},
    });
    expect(code).toBe(0);
    // The missing workdir was created (no ENOENT on npx's cwd) ...
    expect(fs.existsSync(workdir)).toBe(true);
    // ... and the install targets it (NOT global, NOT cwd) so it lands in <workdir>/.claude/skills.
    expect(installed).toEqual([{ cwd: path.resolve(workdir) }]);
  });

  test("a successful create with no workdir + no returned id does NOT install (no shared-parent fallback)", async () => {
    const cfg = tmpConfig({ cron: "0 8 * * *", task: "report" }); // no workdir
    let called = false;
    const installer = async (): Promise<InstallOutcome> => {
      called = true;
      return { ok: true, line: "" };
    };
    const code = await runCreate(["--config", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, name: "Cookie" }), // no id
      installer,
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(called).toBe(false); // resolveLoopWorkdir → "" → install skipped
  });

  test("a failed create does NOT install the skill", async () => {
    const workdir = tmpWorkdir();
    const cfg = tmpConfig({ cron: "0 8 * * *", task: "report", workdir });
    let called = false;
    const installer = async (): Promise<InstallOutcome> => {
      called = true;
      return { ok: true, line: "" };
    };
    const code = await runCreate(["--config", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => errResponse(400, { error: "bad cron" }),
      installer,
      stdout: () => {},
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(fs.existsSync(workdir)).toBe(false); // a failed create touches nothing
  });

  test("an install failure does NOT fail the create (best-effort, swallowed)", async () => {
    const workdir = tmpWorkdir();
    const cfg = tmpConfig({ cron: "0 8 * * *", task: "report", workdir });
    const installer = async (): Promise<InstallOutcome> => {
      throw new Error("npx ENOENT");
    };
    const out: string[] = [];
    const code = await runCreate(["--config", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie" }),
      installer,
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("created loop Cookie");
  });
});
