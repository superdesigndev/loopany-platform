import { describe, expect, it, vi } from "vitest";
import { run, type CliDeps } from "../src/index.js";

const deps: CliDeps = {
  cwd: "/a/path/help-must-not-read",
  now: "2026-08-12T00:00:00.000Z",
  env: {},
  registryHome: "/a/path/help-must-not-read",
  probe: vi.fn(() => {
    throw new Error("help touched the environment");
  }),
  gitEmail: vi.fn(() => {
    throw new Error("help touched git");
  }),
};

describe("per-command help", () => {
  const topLevel = [
    "init", "register", "unregister", "connect", "create", "update", "note",
    "doc", "mirror", "workflow", "show", "list", "ls", "search", "inbox", "loops", "timeline",
    "kanban", "run", "tick",
  ];

  it.each(topLevel)("%s --help succeeds without touching a backend", (verb) => {
    const out = run([verb, "--help"], deps);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout.toLowerCase()).toContain(verb);
  });

  it.each([
    ["doc", "put"],
    ["doc", "list"],
    ["mirror", "add"],
    ["mirror", "list"],
    ["workflow", "show"],
    ["workflow", "set"],
    ["workflow", "clear"],
    ["workflow", "validate"],
  ])("%s %s --help is specific to the nested command", (verb, sub) => {
    const out = run([verb, sub, "--help"], deps);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain(`lk ${verb} ${sub}`);
    expect(out.stdout).not.toContain(`lk ${verb} ${sub === "put" || sub === "add" ? "list" : verb === "doc" ? "put" : "add"}`);
  });

  it("supports -h and help aliases", () => {
    expect(run(["show", "-h"], deps).exitCode).toBe(0);
    expect(run(["show", "help"], deps).exitCode).toBe(0);
    expect(run(["doc", "put", "-h"], deps).stdout).toContain("lk doc put");
  });

  it("diagnoses an unknown command before interpreting --help as a flag", () => {
    const out = run(["not-a-command", "--help"], deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unknown verb "not-a-command"');
    expect(out.stderr).not.toContain("Unknown option");
  });

  it("ls is a complete alias of list", () => {
    const help = run(["ls", "--help"], deps);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("ls is an alias of list");
    expect(help.stdout).toContain("usage: lk list");
  });

  it.each(["list", "inbox", "loops"])("%s documents compact JSON and its --full compatibility escape hatch", (verb) => {
    const help = run([verb, "--help"], deps).stdout;
    expect(help).toContain("--full");
    expect(help).toContain("bodyBytes/bodyCommand");
  });

  it.each([
    [["register", "--dry-run"], "--dry-run is not supported by register"],
    [["show", "task-1", "--full"], "--full is not supported by show"],
    [["list", "--full"], "--full is not supported by list without --json"],
    [["run", "task-1", "--wait"], "--wait is not supported by run"],
  ])("rejects an inapplicable flag before touching a backend: %j", (argv, message) => {
    const out = run(argv, deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(message);
  });

  it("reports an unknown nested command before validating its flags", () => {
    const out = run(["doc", "nope", "--json"], deps);
    expect(out.exitCode).toBe(2);
    expect(JSON.parse(out.stderr).message).toContain('doc supports "doc put');
    expect(out.stderr).not.toContain("--json is not supported");
  });

  it.each([
    ["register", "extra"],
    ["list", "extra"],
    ["show", "task-1", "extra"],
    ["run", "task-1", "extra", "--dry-run"],
    ["timeline", "extra"],
    ["doc", "list", "extra"],
    ["mirror", "list", "extra"],
  ])("rejects surplus positional input: %j", (...argv) => {
    const out = run(argv, deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("expects");
  });

  it("rejects k=v assignments on commands that do not consume them", () => {
    const out = run(["list", "status=todo"], deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("does not accept k=v assignments");
  });
});
