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
    "doc", "mirror", "show", "list", "ls", "search", "inbox", "loops", "timeline",
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
});
