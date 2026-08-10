/**
 * Parser + error-boundary behavior (owner directive: node:util parseArgs, strict
 * mode, parsed inside the try). Every case here was an EMPIRICALLY confirmed
 * bug in the retired hand-rolled parser:
 *   C1  `list --due` threw uncaught (declared value-bearing, usage says boolean)
 *   C2  a missing flag value threw uncaught (parse ran before the try)
 *   C3  `-p P0` silently dropped priority (single-dash never parsed)
 *   C4  `--dry-rnu` silently PERSISTED (unknown --flags became booleans)
 *   C5  `--if-version abc` misreported as a CONFLICT (Number() unchecked)
 *   S4  usage errors ignored --json
 * plus S5 (M6: init accepts a server-URL backend, rejects a malformed one).
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";

describe("CLI parser + error boundary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-args-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (over?: Partial<CliDeps>): CliDeps => ({
    cwd: dir,
    now: "2026-08-09T12:00:00.000Z",
    env: {},
    // Isolate the workspace registry + PATH probe so `init` never writes the real
    // ~/.loopany or seeds from the host's installed agents (test hazard).
    registryHome: dir,
    probe: () => false,
    ...over,
  });
  const call = (argv: string[], over?: Partial<CliDeps>) => run(argv, deps(over));
  const init = () => call(["init"]);

  it("C1: `list --due` is a boolean filter, not a value-bearing flag (no throw)", () => {
    init();
    const out = call(["list", "--due"]);
    expect(out.exitCode).toBe(0);
  });

  it("C2: a missing flag value is a USAGE error (exit 2), not an uncaught throw", () => {
    init();
    const out = call(["create", "x", "--parent"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("usage:");
    // and nothing was persisted
    expect(existsSync(join(dir, ".loopany", "objects", "x.md"))).toBe(false);
  });

  it("C3: `-p P0` binds priority (single-dash short option)", () => {
    init();
    const out = call(["create", "Urgent", "-p", "P0", "--json"]);
    expect(out.exitCode).toBe(0);
    const show = call(["show", "urgent", "--json"]);
    const obj = (JSON.parse(show.stdout) as { object: { priority: string } }).object;
    expect(obj.priority).toBe("P0");
  });

  it("C4: an unknown flag is REJECTED (exit 2), never silently persisted", () => {
    init();
    const out = call(["create", "Test", "--dry-rnu"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toLowerCase()).toContain("unknown option");
    // The silent-data-loss precedent: the object must NOT exist.
    expect(readdirSync(join(dir, ".loopany", "objects"))).toHaveLength(0);
  });

  it("C5: `--if-version abc` is a usage error (exit 2), not a bogus CONFLICT", () => {
    init();
    call(["create", "Urgent", "--json"]);
    const out = call(["update", "urgent", "status=in-progress", "--if-version", "abc"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--if-version");
    expect(out.stderr).not.toContain("CONFLICT");
  });

  it("C5: an empty --if-version is likewise rejected (would coerce to 0)", () => {
    init();
    call(["create", "Urgent", "--json"]);
    const out = call(["update", "urgent", "status=in-progress", "--if-version", "-3"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--if-version");
  });

  it("C5: a valid non-negative --if-version still reaches the kernel (CONFLICT on mismatch)", () => {
    init();
    call(["create", "Urgent", "--json"]);
    const out = call(["update", "urgent", "status=in-progress", "--if-version", "99"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("CONFLICT");
  });

  it("S4: a usage error honors --json (structured, not plain text)", () => {
    init();
    const out = call(["update", "--json"]);
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stderr) as { ok: boolean; code: string; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("USAGE");
    expect(parsed.message).toContain("update needs an <id>");
  });

  it("S4: a PARSE-level usage error (unknown flag) also honors --json", () => {
    init();
    const out = call(["create", "X", "--bogus", "--json"]);
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stderr) as { code: string };
    expect(parsed.code).toBe("USAGE");
  });

  it("S4: an unknown verb honors --json", () => {
    const out = call(["frobnicate", "--json"]);
    expect(out.exitCode).toBe(2);
    const parsed = JSON.parse(out.stderr) as { code: string };
    expect(parsed.code).toBe("USAGE");
  });

  it("S5 (M6): init --backend <server-url> is accepted and recorded", () => {
    const out = call(["init", "--backend", "https://example.com", "--json"]);
    expect(out.exitCode).toBe(0);
    // The server URL is stored as the workspace's authority (the remote backend
    // POSTs every Command there).
    const cfg = JSON.parse(readFileSync(join(dir, ".loopany", "config.json"), "utf8")) as {
      backend: string;
    };
    expect(cfg.backend).toBe("https://example.com");
  });

  it("S5 (M6): init rejects a backend that is neither `local` nor an http(s) URL", () => {
    const out = call(["init", "--backend", "prod"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(/http\(s\) server URL/);
    // No workspace was created for the rejected backend.
    expect(existsSync(join(dir, ".loopany", "config.json"))).toBe(false);
  });

  it("S5: init --backend local still works", () => {
    const out = call(["init", "--backend", "local"]);
    expect(out.exitCode).toBe(0);
    expect(existsSync(join(dir, ".loopany", "config.json"))).toBe(true);
  });

  it("preserves the bare k=v update patch grammar", () => {
    init();
    call(["create", "Urgent", "--json"]);
    const out = call(["update", "urgent", "status=in-progress", "priority=P1"]);
    expect(out.exitCode).toBe(0);
    const show = call(["show", "urgent", "--json"]);
    const obj = (JSON.parse(show.stdout) as { object: { status: string; priority: string } }).object;
    expect(obj.status).toBe("in-progress");
    expect(obj.priority).toBe("P1");
  });
});
