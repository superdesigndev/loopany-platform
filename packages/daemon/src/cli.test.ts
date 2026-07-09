/**
 * Dispatch behavior of the CLI entry, run as a real subprocess (the faithful
 * "what does a user typing `adscaile …` get" check). Proves the new help/unknown
 * handling does NOT fall through to launching a daemon: each invocation EXITS
 * (the daemon would hang on its poll loop) with the expected code + output.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { legacyRun, postCli, resolveCredential } from "./cli-client.js";
import { classify } from "./route.js";
import { daemonVersion } from "./version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(here, "../node_modules/.bin/tsx");
const entry = path.resolve(here, "cli.ts");

type Run = { code: number; stdout: string; stderr: string };

/** Run the CLI with a clean env (no run token; isolated ADSCAILE_HOME). */
function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const env = { ...process.env, ADSCAILE_HOME: path.join(os.tmpdir(), "adscaile-cli-test-home") };
    delete env.ADSCAILE_RUN_TOKEN;
    execFile(tsx, [entry, ...args], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("adscaile CLI dispatch", () => {
  test("--help prints usage and exits 0 (no daemon)", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: adscaile");
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("down");
    expect(r.stdout).toContain("update");
  });

  test("-h prints usage and exits 0", async () => {
    const r = await runCli(["-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: adscaile");
  });

  test("--help leads with the daemon version (reused, not hardcoded)", async () => {
    const version = daemonVersion();
    expect(version).toBeTruthy(); // resolvable from this package's package.json
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`adscaile v${version}`);
  });

  test("--version prints just the version and exits 0 (no daemon)", async () => {
    const version = daemonVersion();
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`adscaile v${version}`);
    expect(r.stdout).not.toContain("Usage: adscaile"); // version only, not the full screen
  });

  test("-v prints the version and exits 0", async () => {
    const version = daemonVersion();
    const r = await runCli(["-v"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`adscaile v${version}`);
  });

  test("help (bare verb) prints usage and exits 0", async () => {
    const r = await runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: adscaile");
  });

  test("unknown flag → exits non-zero with hint, does not launch daemon", async () => {
    const r = await runCli(["--frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("--help");
  });

  test("unknown verb → exits non-zero with hint", async () => {
    const r = await runCli(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });

  test("update with no connection → exits (never launches daemon)", async () => {
    // Isolated ADSCAILE_HOME has no stored server/token, so update returns 2 with a
    // clear message instead of hanging on a poll loop.
    const r = await runCli(["update"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not connected");
  });

  test("update --help prints usage and exits 0 WITHOUT the daemon handover (the foot-gun)", async () => {
    // The primary must-fix: `--help` is parsed before `runUpdate`, so no `down`/re-ensure
    // side effect fires — even on an isolated home. Contrast the `update` (no --help) test
    // above, which reaches the handler and reports "not connected".
    const r = await runCli(["update", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("adscaile update");
    expect(r.stdout).toContain("Run `adscaile --help` for all commands.");
    expect(r.stderr).not.toContain("not connected"); // handler never ran
  });

  test("update -h short-circuits to help too", async () => {
    const r = await runCli(["update", "-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("adscaile update");
  });

  test("down --help prints usage and exits 0 (never stops a daemon)", async () => {
    const r = await runCli(["down", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("adscaile down");
    expect(r.stdout).toContain("Stop the detached daemon");
  });

  test("up --foreground --help shows help instead of launching the poll loop", async () => {
    // The ordering hazard: `up --foreground` would classify to `daemon` and hang. Help
    // is parsed first, so this exits 0 with usage.
    const r = await runCli(["up", "--foreground", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("adscaile up");
  });

  test("bare `adscaile` (no args) → the content-first home, NOT the poll loop (exit 0)", async () => {
    // The Batch-6 behavior change: bare `adscaile` no longer blocks on the daemon. With
    // an isolated ADSCAILE_HOME (no credential/server) it renders the definitive
    // not-connected home and exits, rather than hanging on a poll loop.
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not connected — run `adscaile up`");
  });

  test("help lists the new surface (bare = home, up --foreground, setup, device show)", async () => {
    const r = await runCli(["--help"]);
    expect(r.stdout).toContain("content-first HOME");
    expect(r.stdout).toContain("up [--foreground]");
    expect(r.stdout).toContain("setup hooks");
    expect(r.stdout).toContain("show [<id>]");
  });
});

/**
 * The pure routing table (`classify`) — the Batch-6 dispatch is unit-tested here so we
 * cover the daemon-launch paths (which would hang a subprocess) deterministically.
 */
describe("classify — CLI routing table (Batch 6)", () => {
  test("bare `adscaile` OUT of a run → the content-first home (device cred), never the daemon", () => {
    expect(classify([], {})).toEqual({ kind: "home" });
  });

  test("bare `adscaile` IN a run (zero args) → the callback posts `home` on the run cred (fixes the argv>0 guard)", () => {
    expect(classify([], { ADSCAILE_RUN_TOKEN: "rk_x" })).toEqual({ kind: "callback", argv: ["home"] });
  });

  test("any verb IN a run funnels through the callback (run cred)", () => {
    expect(classify(["report", "--status", "new"], { ADSCAILE_RUN_TOKEN: "rk_x" })).toEqual({
      kind: "callback",
      argv: ["report", "--status", "new"],
    });
  });

  test("the foreground poll loop moved: `up --foreground` → daemon, plain `up` → ensure", () => {
    expect(classify(["up", "--foreground"], {})).toEqual({ kind: "daemon" });
    expect(classify(["up"], {})).toEqual({ kind: "ensure", args: [] });
    expect(classify(["up", "--server-url", "http://x"], {})).toEqual({ kind: "ensure", args: ["--server-url", "http://x"] });
  });

  test("the `--server-url` re-exec path still launches the daemon (preserved)", () => {
    expect(classify(["--server-url", "http://x", "--api-key", "dk_y"], {})).toEqual({ kind: "daemon" });
    expect(classify(["--api-key", "dk_y"], {})).toEqual({ kind: "daemon" });
  });

  test("run-only verbs OUTSIDE a run are FORWARDED (device cred → server 403), not unknown", () => {
    expect(classify(["report", "--status", "new"], {})).toEqual({ kind: "forward", argv: ["report", "--status", "new"] });
    expect(classify(["finish"], {})).toEqual({ kind: "forward", argv: ["finish"] });
    expect(classify(["complete"], {})).toEqual({ kind: "forward", argv: ["complete"] });
  });

  test("setup + device show route to their handlers", () => {
    expect(classify(["setup", "hooks"], {})).toEqual({ kind: "setup", args: ["hooks"] });
    expect(classify(["show", "loop-1"], {})).toEqual({ kind: "show", args: ["loop-1"] });
  });

  test("an unknown verb is still `unknown` (→ exit 2), never a silent daemon launch", () => {
    expect(classify(["bogus"], {})).toEqual({ kind: "unknown", verb: "bogus" });
    expect(classify(["--frobnicate"], {})).toEqual({ kind: "unknown", verb: "--frobnicate" });
  });

  test("`<verb> --help`/`-h` short-circuits to per-verb help BEFORE any side effect (structural)", () => {
    // Every recognized command verb — including the foot-guns — routes to help, not its handler.
    expect(classify(["update", "--help"], {})).toEqual({ kind: "help", verb: "update" });
    expect(classify(["update", "-h"], {})).toEqual({ kind: "help", verb: "update" });
    expect(classify(["down", "--help"], {})).toEqual({ kind: "help", verb: "down" });
    expect(classify(["setup", "hooks", "--help"], {})).toEqual({ kind: "help", verb: "setup" });
    expect(classify(["skill", "-h"], {})).toEqual({ kind: "help", verb: "skill" });
    expect(classify(["status", "--help"], {})).toEqual({ kind: "help", verb: "status" });
    expect(classify(["new", "--help"], {})).toEqual({ kind: "help", verb: "new" });
  });

  test("help wins over the `up --foreground`→daemon branch (no poll loop for `--help`)", () => {
    expect(classify(["up", "--foreground", "--help"], {})).toEqual({ kind: "help", verb: "up" });
    expect(classify(["up", "--help"], {})).toEqual({ kind: "help", verb: "up" });
  });

  test("a run-only forward verb with --help shows local help out-of-run (no forward, no side effect)", () => {
    expect(classify(["report", "--help"], {})).toEqual({ kind: "help", verb: "report" });
  });

  test("--help IN a run stays a callback (server renders it; the router never intercepts)", () => {
    expect(classify(["update", "--help"], { ADSCAILE_RUN_TOKEN: "rk_x" })).toEqual({
      kind: "callback",
      argv: ["update", "--help"],
    });
  });

  test("an unknown verb carrying --help stays unknown (not intercepted)", () => {
    expect(classify(["bogus", "--help"], {})).toEqual({ kind: "unknown", verb: "bogus" });
  });
});

/**
 * The shared CLI client (`postCli`) is what makes the one-grammar convergence work:
 * it selects the credential by env (run token wins, else device), inlines the file
 * flags, POSTs `{argv}` to /api/machine/cli, and falls back on a 404. These unit the
 * credential selection + endpoint choice directly (the subprocess dispatch above proves
 * the local fast-paths still exit without the daemon).
 */
describe("postCli credential selection", () => {
  test("resolveCredential: the run token (env) wins over the device token", () => {
    const cred = resolveCredential({ env: { ADSCAILE_RUN_TOKEN: "run-1" }, deviceToken: "dk_dev" });
    expect(cred).toEqual({ token: "run-1", isRun: true });
  });

  test("resolveCredential: no run token in env → the persisted device token, isRun=false", () => {
    const cred = resolveCredential({ env: {}, deviceToken: "dk_dev" });
    expect(cred).toEqual({ token: "dk_dev", isRun: false });
  });

  test("resolveCredential: neither present → undefined (not connected)", () => {
    expect(resolveCredential({ env: {}, deviceToken: undefined })).toBeUndefined();
  });

  test("attaches the RUN token from env and posts {argv} to /api/machine/cli", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return { status: 200, ok: true, json: async () => ({ text: "ok", exitCode: 0 }) };
    }) as unknown as typeof fetch;
    const r = await postCli(["report", "--status", "new"], legacyRun, {
      env: { ADSCAILE_RUN_TOKEN: "run-xyz" },
      server: "https://srv.test",
      fetchImpl,
    });
    expect(r).toMatchObject({ kind: "ok", status: 200 });
    expect(calls[0].url).toBe("https://srv.test/api/machine/cli");
    expect(calls[0].init.headers.Authorization).toBe("Bearer run-xyz");
    expect(JSON.parse(calls[0].init.body).argv).toEqual(["report", "--status", "new"]);
  });

  test("no run token → posts with the persisted DEVICE token", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return { status: 200, ok: true, json: async () => ({ ok: true, loops: [] }) };
    }) as unknown as typeof fetch;
    await postCli(["loops"], legacyRun, { env: {}, deviceToken: "dk_dev", server: "https://srv.test", fetchImpl });
    expect(calls[0].init.headers.Authorization).toBe("Bearer dk_dev");
  });

  test("no credential/server → not-configured, never fetches", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { status: 200, ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await postCli(["loops"], legacyRun, { env: {}, deviceToken: undefined, server: "", fetchImpl });
    expect(r).toEqual({ kind: "not-configured" });
    expect(called).toBe(false);
  });
});
