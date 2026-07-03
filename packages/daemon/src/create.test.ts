/**
 * Agent recording at `loopany new`: the env-fingerprint detector and the
 * resolution precedence (measured env > declared --agent/config > undefined).
 * Pure functions, no network — they decide the `agent` field the create POST
 * carries (or omits, letting the server default it to claude-code).
 *
 * Plus the skill-install trigger at create: that the USER-scope install fires only
 * after a confirmed create, never blocking it (both with the fetch + installer seams
 * injected, so nothing hits the network or spawns npx).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { coerceAgent, cronLooksValid, detectAgentFromEnv, resolveAgent, runCreate } from "./create.js";
import type { InstallOpts, InstallOutcome } from "./skill-install.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errResponse = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

/** The inline `--json '<config>'` string (batch 2 replaced the `--config <file>` ritual). */
function cfgJson(cfg: object): string {
  return JSON.stringify(cfg);
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

describe("runCreate — skill install fires only after a confirmed create, never blocks it", () => {
  const prevToken = process.env.LOOPANY_TOKEN;
  beforeEach(() => {
    process.env.LOOPANY_TOKEN = "dk_test"; // satisfy the "machine connected" precheck without touching disk
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.LOOPANY_TOKEN;
    else process.env.LOOPANY_TOKEN = prevToken;
  });

  test("a successful create installs the skill at USER scope (global), independent of workdir", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md", workdir: tmpWorkdir() });
    const installed: InstallOpts[] = [];
    const installer = async (opts: InstallOpts): Promise<InstallOutcome> => {
      installed.push(opts);
      return { ok: true, line: "loopany skill: installed → ~/.claude/skills/loopany" };
    };
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie" }),
      installer,
      stdout: () => {},
    });
    expect(code).toBe(0);
    // The install targets the user dir (global) — never the loop workdir/cwd.
    expect(installed).toEqual([{ global: true }]);
  });

  test("a successful create with no workdir + no returned id STILL installs (user scope needs neither)", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md" }); // no workdir
    const installed: InstallOpts[] = [];
    const installer = async (opts: InstallOpts): Promise<InstallOutcome> => {
      installed.push(opts);
      return { ok: true, line: "" };
    };
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, name: "Cookie" }), // no id
      installer,
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(installed).toEqual([{ global: true }]);
  });

  test("a failed create does NOT install the skill", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
    let called = false;
    const installer = async (): Promise<InstallOutcome> => {
      called = true;
      return { ok: true, line: "" };
    };
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => errResponse(400, { error: "bad cron" }),
      installer,
      stdout: () => {},
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
  });

  test("an install failure does NOT fail the create (best-effort, swallowed)", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
    const installer = async (): Promise<InstallOutcome> => {
      throw new Error("npx ENOENT");
    };
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie" }),
      installer,
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("created loop Cookie");
  });

  test("--dry-run renders the preview (config + fire times + classification) and does NOT create/install", async () => {
    const workdir = tmpWorkdir();
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md", workdir, goal: "ship v1" });
    let installed = false;
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--dry-run", "--server-url", "http://test"], {
      fetchImpl: async () =>
        okResponse({
          ok: true,
          dryRun: true,
          config: { name: null, cron: "0 8 * * *", taskFile: "loopany/x/README.md", workflow: false, goal: "ship v1" },
          timezone: "UTC",
          nextRuns: ["2026-07-03T08:00:00.000Z", "2026-07-04T08:00:00.000Z", "2026-07-05T08:00:00.000Z"],
          classification: "closed",
          classificationText: "closed (has goal): will self-finish when the goal is met",
        }),
      installer: async () => {
        installed = true;
        return { ok: true, line: "" };
      },
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(installed).toBe(false); // dry-run never creates → never installs
    expect(fs.existsSync(workdir)).toBe(false); // touches nothing
    const text = out.join("");
    expect(text).toContain("dry-run");
    expect(text).toContain("self-finish"); // the classification line
    expect(text).toContain("2026-07-03T08:00:00.000Z"); // first of the 3 fire times
  });

  test("`new` without --json prints usage (exit 2), makes no request", async () => {
    let called = false;
    const code = await runCreate(["--server-url", "http://test"], {
      fetchImpl: async () => {
        called = true;
        return okResponse({});
      },
      stdout: () => {},
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  test("`new` with a config missing both workflow and taskFile is rejected locally (exit 2)", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *" }); // no workflow, no taskFile
    let called = false;
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => {
        called = true;
        return okResponse({});
      },
      stdout: () => {},
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });
});
