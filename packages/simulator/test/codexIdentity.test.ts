/**
 * CODEX identity seeding (fake seams - the real ~/.codex is never read) + the
 * codex tier's executor profile shape.
 */
import { describe, expect, it } from "vitest";
import { seedCodexIdentity, type CodexIdentityDeps } from "../src/codexIdentity.js";
import { agentProfileFor } from "../src/run.js";

function fakeDeps(files: Record<string, string>) {
  const writes: Record<string, string> = {};
  const chmods: Record<string, number> = {};
  const deps: CodexIdentityDeps = {
    readFile: (p) => {
      if (files[p] === undefined) throw new Error("ENOENT");
      return files[p];
    },
    writeFile: (p, c) => {
      writes[p] = c;
    },
    mkdir: () => {},
    chmod: (p, m) => {
      chmods[p] = m;
    },
    realHome: () => "/home/u",
  };
  return { deps, writes, chmods };
}

describe("seedCodexIdentity", () => {
  it("copies the real auth.json into CODEX_HOME, chmod 600", () => {
    const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "t" } });
    const { deps, writes, chmods } = fakeDeps({ "/home/u/.codex/auth.json": auth });
    const res = seedCodexIdentity("/sandbox/codex-home", deps);
    expect(res.codexHome).toBe("/sandbox/codex-home");
    expect(writes["/sandbox/codex-home/auth.json"]).toBe(auth);
    expect(chmods["/sandbox/codex-home/auth.json"]).toBe(0o600);
    // ONLY auth.json is seeded - the user's config.toml (hooks/notify wiring)
    // must never ride into the sandbox.
    expect(Object.keys(writes)).toEqual(["/sandbox/codex-home/auth.json"]);
  });

  it("fails loud with the codex-login hint when auth.json is absent or invalid", () => {
    expect(() => seedCodexIdentity("/x", fakeDeps({}).deps)).toThrow(/codex login/);
    expect(() =>
      seedCodexIdentity("/x", fakeDeps({ "/home/u/.codex/auth.json": "not json" }).deps),
    ).toThrow(/not valid JSON/);
  });
});

describe("agentProfileFor(codex)", () => {
  it("runs codex exec with the sandbox bypass + git check skip, prompt last", () => {
    const p = agentProfileFor("codex");
    expect(p.cmd).toBe(process.env.LOOPANY_CODEX_BIN ?? "codex");
    expect(p.args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "{{prompt}}",
    ]);
  });
});
