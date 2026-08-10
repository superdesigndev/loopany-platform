/**
 * SANDBOX rings 1+2 + the plant repo: a fake-HOME gitconfig, a per-sandbox shims
 * dir first on PATH (the fake `gh`), and the W3 stand-in repo git-inited with a
 * bare origin. Exercises the REAL gh shim + plantRepo end to end (no mocks - a
 * temp sandbox), which is the point: the fix arc must be real work.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, fixturesDir, plantRepo } from "../src/index.js";
import { readRecordedPrs } from "../src/probe.js";

describe("sandbox rings 1+2", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-rings-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("ring 1: a fake-HOME gitconfig with the Sim Agent identity + main default", () => {
    const sb = createSandbox({ dir: root, profiles: {} }, "2026-08-24T00:00:00.000Z");
    const config = readFileSync(join(sb.home, ".gitconfig"), "utf8");
    expect(config).toContain("name = Sim Agent");
    expect(config).toContain("email = sim@loopany.local");
    expect(config).toContain("defaultBranch = main");
  });

  it("ring 2: the shims dir is copied in and FIRST on PATH, LOOPANY_SANDBOX set", () => {
    const sb = createSandbox({ dir: root, profiles: {} }, "2026-08-24T00:00:00.000Z");
    expect(existsSync(join(sb.root, "shims", "gh"))).toBe(true);
    expect(sb.env.PATH.startsWith(join(sb.root, "shims"))).toBe(true);
    expect(sb.env.LOOPANY_SANDBOX).toBe(sb.root);
  });
});

describe("plantRepo + gh shim", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-plant-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function plant() {
    const sb = createSandbox({ dir: root, profiles: {} }, "2026-08-24T00:00:00.000Z");
    const repo = plantRepo(sb, join(fixturesDir(), "superdesign-web"));
    return { sb, repo };
  }

  it("plants the stand-in repo with the planted bug + a bare origin", () => {
    const { sb, repo } = plant();
    // The planted bug line is present in the working tree.
    const wrapper = readFileSync(join(repo, "public", "install-wrapper.js"), "utf8");
    expect(wrapper).toContain("new ClipboardItem");
    // A bare origin exists and is wired.
    expect(existsSync(join(sb.root, "remotes", "superdesign-web.git"))).toBe(true);
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repo,
      env: sb.env,
      encoding: "utf8",
    }).trim();
    expect(remote).toBe(join(sb.root, "remotes", "superdesign-web.git"));
    // The initial commit exists on main.
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      env: sb.env,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("main");
  });

  it("origin rejects a direct main push (branch protection) but accepts a feature branch", () => {
    const { sb, repo } = plant();
    const git = (a: string[]) => execFileSync("git", a, { cwd: repo, env: sb.env, encoding: "utf8" });
    writeFileSync(join(repo, "README.md"), "tweak\n");
    git(["commit", "-am", "tweak"]);
    // Direct main push refused with the protected-branch message (haiku-3 escape hatch).
    expect(() => git(["push", "origin", "main"])).toThrowError(/protected branch main/);
    // The same commit lands fine on a feature branch.
    git(["checkout", "-b", "fix/tweak"]);
    git(["push", "origin", "fix/tweak"]);
    const heads = execFileSync("git", ["branch"], {
      cwd: join(sb.root, "remotes", "superdesign-web.git"),
      env: sb.env,
      encoding: "utf8",
    });
    expect(heads).toContain("fix/tweak");
  });

  it("gh pr create records a PR with changedFiles + audits, list reads it back", () => {
    const { sb, repo } = plant();
    const env = { ...sb.env, LOOPANY_NOW: "2026-08-28T07:00:00.000Z" };
    const git = (a: string[]) => execFileSync("git", a, { cwd: repo, env, encoding: "utf8" });

    git(["checkout", "-b", "fix/clipboard"]);
    const f = join(repo, "public", "install-wrapper.js");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace(
        "const item = new ClipboardItem",
        "if (typeof ClipboardItem === 'undefined') { await clipboard.writeText(text); return 'copied'; }\n  const item = new ClipboardItem",
      ),
    );
    git(["commit", "-am", "guard clipboard"]);

    const out = execFileSync("gh", ["pr", "create", "--title", "Fix", "--body", "b", "--head", "fix/clipboard"], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim();
    expect(out).toMatch(/github\.com\/superdesigndev\/superdesign-web\/pull\/1/);

    // The recorded PR carries the changed file (derived via git diff main...HEAD).
    const prs = readRecordedPrs(sb.root);
    expect(prs).toHaveLength(1);
    expect(prs[0].changedFiles).toContain("public/install-wrapper.js");

    // The audit log recorded the invocation with the virtual now.
    const audit = readFileSync(join(sb.root, "audit.log"), "utf8");
    expect(audit).toContain("2026-08-28T07:00:00.000Z gh pr create");

    // `gh pr list` reads the recorded PRs.
    const list = execFileSync("gh", ["pr", "list"], { cwd: repo, env, encoding: "utf8" });
    expect(list).toContain("#1");
  });

  it("an unknown gh subcommand records + exits 1 without crashing", () => {
    const { sb, repo } = plant();
    const env = { ...sb.env, LOOPANY_NOW: "2026-08-28T07:00:00.000Z" };
    // execFileSync throws on a nonzero exit; capture the status + stderr.
    let status = 0;
    let stderr = "";
    try {
      execFileSync("gh", ["issue", "create"], { cwd: repo, env, encoding: "utf8" });
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
      stderr = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/not supported/);
    // Still audited.
    expect(readFileSync(join(sb.root, "audit.log"), "utf8")).toContain("gh issue create");
  });
});
