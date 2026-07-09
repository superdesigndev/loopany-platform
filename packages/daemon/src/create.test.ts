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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { canonicalJson, coerceAgent, cronLooksValid, detectAgentFromEnv, idempotencyKey, resolveAgent, runCreate } from "./create.js";
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

  test("fingerprints Grok Build from its GROK_AGENT child marker", () => {
    expect(detectAgentFromEnv({ GROK_AGENT: "1" })).toBe("grok");
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
    expect(coerceAgent("grok")).toBe("grok");
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
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie", text: "created: Cookie (loop-1)", exitCode: 0 }),
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
      fetchImpl: async () => okResponse({ ok: true, name: "Cookie", text: "created: Cookie (loop-1)", exitCode: 0 }), // no id
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
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie", text: "created: Cookie (loop-1)", exitCode: 0 }),
      installer,
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("created: Cookie (loop-1)");
  });

  test("text sink: a new server's `text` is printed verbatim (not the structured line), and the skill still installs", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
    const toon = "created: Cookie (loop-1)\nclassification: open — runs until paused\ndashboard: not applied";
    const installed: InstallOpts[] = [];
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "Cookie", text: toon, exitCode: 0 }),
      installer: async (opts) => { installed.push(opts); return { ok: true, line: "loopany skill: installed" }; },
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain(toon); // the server render, verbatim
    expect(text).not.toContain("created loop Cookie"); // NOT the old structured line
    expect(installed).toEqual([{ global: true }]); // still runs after a confirmed create
  });

  test("text sink: a --dry-run new server prints its `text` preview (no structured fallback)", async () => {
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
    const toon = "dry-run:\n  name: —\n  cron: 0 8 * * *\nclassification: open — runs until paused";
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--dry-run", "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, dryRun: true, text: toon, exitCode: 0 }),
      installer: async () => { throw new Error("should not install on dry-run"); },
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain(toon);
  });

  test("--dry-run text-sinks the server's preview and does NOT create/install", async () => {
    const workdir = tmpWorkdir();
    const cfg = cfgJson({ cron: "0 8 * * *", taskFile: "loopany/x/README.md", workdir, goal: "ship v1" });
    // The server renders the whole preview into `text` (config + fire times +
    // classification); the daemon is a pure text sink now.
    const toon = [
      "dry-run:",
      "  cron: 0 8 * * *",
      "  goal: ship v1",
      "classification: closed (has goal): will self-finish when the goal is met",
      'nextRuns[3]: "2026-07-03 08:00" · "2026-07-04 08:00" · "2026-07-05 08:00"',
    ].join("\n");
    let installed = false;
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--dry-run", "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, dryRun: true, text: toon, exitCode: 0 }),
      installer: async () => {
        installed = true;
        return { ok: true, line: "" };
      },
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(installed).toBe(false); // dry-run never creates → never installs
    expect(fs.existsSync(workdir)).toBe(false); // touches nothing
    expect(out.join("")).toBe(toon + "\n"); // the server preview, verbatim
  });

  test("posts the whole config (including `ui`) to the unified /api/machine/cli as `new --json`", async () => {
    const ui = '<h3>React Doctor</h3><loop-chart series="score:Red Dot Score"></loop-chart><loop-kanban columns="open,merged"></loop-kanban>';
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "loopany/react-doctor/README.md", ui });
    let sentUrl = "";
    let sentBody: any = null;
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async (url: any, init: any) => {
        sentUrl = String(url);
        sentBody = JSON.parse(init.body as string);
        return okResponse({ ok: true, id: "loop-1", name: "React Doctor", ui: true, text: "created: React Doctor (loop-1)\ndashboard: applied", exitCode: 0 });
      },
      installer: async () => ({ ok: true, line: "" }),
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    // The unified dispatch (batch 4/5) is hit, carrying `new --json <config>`.
    expect(sentUrl).toContain("/api/machine/cli");
    expect(sentBody.argv[0]).toBe("new");
    expect(sentBody.argv[1]).toBe("--json");
    // The whole config — including ui — rides inside the --json payload (no whitelist drops it).
    expect(JSON.parse(sentBody.argv[2]).ui).toBe(ui);
    // The real create echoes the dashboard presence in the server-rendered `text`.
    expect(out.join("")).toContain("dashboard: applied");
  });

  test("falls back to legacy POST /api/machine/loop with the raw config when the server 404s the unified dispatch", async () => {
    const ui = "<h3>React Doctor</h3>";
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "loopany/react-doctor/README.md", ui });
    const urls: string[] = [];
    let legacyBody: any = null;
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async (url: any, init: any) => {
        urls.push(String(url));
        if (String(url).includes("/api/machine/cli")) return errResponse(404, { error: "not found" });
        // Legacy path: the body is the raw config object (ui present at top level). A
        // batch-1+ legacy `createLoop` renders `text` too, which the daemon text-sinks.
        legacyBody = JSON.parse(init.body as string);
        return okResponse({ ok: true, id: "loop-1", name: "React Doctor", ui: true, text: "created: React Doctor (loop-1)\ndashboard: applied", exitCode: 0 });
      },
      installer: async () => ({ ok: true, line: "" }),
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    // Tried the unified dispatch first, then fell back to the legacy loop endpoint.
    expect(urls.some((u) => u.includes("/api/machine/cli"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/machine/loop"))).toBe(true);
    expect(legacyBody.ui).toBe(ui); // legacy body is the raw config
    expect(out.join("")).toContain("dashboard: applied");
  });

  test("a DROPPED ui is loud in the server-rendered `text`, create still succeeds", async () => {
    // The server folds the dropped-dashboard warning into `text` (renderCreatedText); the
    // daemon text-sinks it (Batch 7 dropped the separate structured `warning`→stderr shout).
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "loopany/x/README.md", ui: "   " });
    const toon = "created: NoDash (loop-1)\ndashboard: not applied\nwarning: the provided ui was empty after validation and was NOT applied — the loop was created without a dashboard";
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, id: "loop-1", name: "NoDash", ui: false, warning: "dropped", text: toon, exitCode: 0 }),
      installer: async () => ({ ok: true, line: "" }),
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0); // create still succeeds
    expect(out.join("")).toContain("dashboard: not applied");
    expect(out.join("")).toContain("without a dashboard");
  });

  test("--dry-run preview text-sinks the ui presence line (present when a ui was given)", async () => {
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "loopany/x/README.md" });
    const out: string[] = [];
    const code = await runCreate(["--json", cfg, "--dry-run", "--server-url", "http://test"], {
      fetchImpl: async () => okResponse({ ok: true, dryRun: true, text: "dry-run:\n  ui: present\nclassification: open: runs until paused", exitCode: 0 }),
      installer: async () => ({ ok: true, line: "" }),
      stdout: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("ui: present");
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

describe("idempotencyKey / canonicalJson (F8 — `new` retry-safety, design §8.1)", () => {
  test("canonicalJson sorts object keys recursively, preserves array order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    // Nested objects also canonicalize; arrays keep order (order is meaningful).
    expect(canonicalJson({ x: { d: 4, c: 3 }, y: [1, 2] })).toBe('{"x":{"c":3,"d":4},"y":[1,2]}');
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("the key is STABLE across retries (same token + config, any key order)", () => {
    const k1 = idempotencyKey("dk_test", { name: "Docs", cron: "0 6 * * 1", taskFile: "x" });
    const k2 = idempotencyKey("dk_test", { taskFile: "x", cron: "0 6 * * 1", name: "Docs" });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/); // a sha256 hex digest
  });

  test("the key DIFFERS across configs and across machines (tokens)", () => {
    const base = { name: "Docs", cron: "0 6 * * 1", taskFile: "x" };
    expect(idempotencyKey("dk_test", base)).not.toBe(idempotencyKey("dk_test", { ...base, cron: "0 7 * * 1" }));
    // A different device token ⇒ a different machine id in the hash ⇒ a different key.
    expect(idempotencyKey("dk_a", base)).not.toBe(idempotencyKey("dk_b", base));
  });

  test("hashing the FULL resolved body closes the envelope-collision class (timezone/claim/agent all count)", () => {
    // The body is the exact outgoing request payload (config + envelope), so any field difference splits the key.
    const body = { name: "Docs", cron: "0 6 * * 1", taskFile: "x", timezone: "Europe/Paris" };
    // Same body ⇒ same key (a genuine retry with identical argv+env still collapses).
    expect(idempotencyKey("dk_test", body)).toBe(idempotencyKey("dk_test", { ...body }));
    // A different --tz (envelope) ⇒ different keys — the tz-collision the previous cherry-pick missed.
    expect(idempotencyKey("dk_test", body)).not.toBe(idempotencyKey("dk_test", { ...body, timezone: "America/New_York" }));
    // A different connect-key/team (rides in `claim`) ⇒ different keys (no cross-team collapse).
    expect(idempotencyKey("dk_test", { ...body, claim: "dk_teamA" })).not.toBe(idempotencyKey("dk_test", { ...body, claim: "dk_teamB" }));
    // A different recorded agent ⇒ different keys.
    expect(idempotencyKey("dk_test", { ...body, agent: "claude-code" })).not.toBe(idempotencyKey("dk_test", { ...body, agent: "codex" }));
    // The idempotencyKey nonce itself is EXCLUDED from the hash (its presence/value can't change the key).
    expect(idempotencyKey("dk_test", body)).toBe(idempotencyKey("dk_test", { ...body, idempotencyKey: "whatever" }));
  });
});

describe("runCreate — sends the idempotency key on a real create, omits it on --dry-run", () => {
  const prevToken = process.env.LOOPANY_TOKEN;
  beforeEach(() => {
    process.env.LOOPANY_TOKEN = "dk_test";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.LOOPANY_TOKEN;
    else process.env.LOOPANY_TOKEN = prevToken;
  });

  // NB: the daemon resolves its token from ~/.loopany/device-token first (env is the
  // fallback), so the integration test can't pin the exact key to a fixed token — it
  // asserts the CONTRACT (present, 64-hex, stable across retries, differs by config).
  // The exact `sha256(machineId + canonicalJSON(resolvedBody))` value is pinned by the
  // pure idempotencyKey tests above.
  const keyOf = (sent: any[]) => JSON.parse(sent[sent.length - 1].argv[2]).idempotencyKey as string | undefined;

  test("a real create stamps a 64-hex `idempotencyKey`, stable across a retry of the same config", async () => {
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "loopany/x/README.md" });
    const sent: any[] = [];
    const run = (json: string) =>
      runCreate(["--json", json, "--server-url", "http://test"], {
        fetchImpl: async (_url: any, init: any) => {
          sent.push(JSON.parse((init as any).body as string));
          return okResponse({ ok: true, id: "loop-1", name: "X", text: "created: X (loop-1)", exitCode: 0 });
        },
        installer: async () => ({ ok: true, line: "" }),
        stdout: () => {},
      });
    expect(await run(cfg)).toBe(0);
    const first = keyOf(sent);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(cfg)).toBe(0); // a retry (same argv)
    expect(keyOf(sent)).toBe(first); // stable across the retry
    // A different config ⇒ a different key (an intentional twin isn't collapsed).
    expect(await run(cfgJson({ cron: "0 6 * * *", taskFile: "loopany/x/README.md" }))).toBe(0);
    expect(keyOf(sent)).not.toBe(first);
  });

  test("--dry-run carries NO idempotency key (a preview creates nothing to dedupe)", async () => {
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "loopany/x/README.md" });
    let payload: any = null;
    const code = await runCreate(["--json", cfg, "--dry-run", "--server-url", "http://test"], {
      fetchImpl: async (_url: any, init: any) => {
        payload = JSON.parse(JSON.parse((init as any).body as string).argv[2]);
        return okResponse({ ok: true, dryRun: true, text: "dry-run:\n  cron: 0 5 * * *", exitCode: 0 });
      },
      installer: async () => ({ ok: true, line: "" }),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(payload.idempotencyKey).toBeUndefined();
    expect(payload.dryRun).toBe(true);
  });
});
