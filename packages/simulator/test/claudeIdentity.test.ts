/**
 * CLAUDE IDENTITY seeding - the verified recipe over FAKE seams. These tests
 * MUST NEVER read the real keychain or the real ~/.claude.json: every external
 * touch is injected. They also pin the load-bearing invariant that the seeded
 * config dir is chosen by the CALLER outside the workspace (a snapshot copies the
 * workspace, so credentials must not live there).
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  CREDENTIALS_SERVICE,
  IDENTITY_KEYS,
  seedClaudeIdentity,
  type IdentityDeps,
} from "../src/claudeIdentity.js";

/** A fake seam set: an in-memory fs, a canned keychain blob, a fake real home. */
function fakeDeps(overrides: Partial<IdentityDeps> = {}): {
  deps: IdentityDeps;
  writes: Record<string, string>;
  chmods: Record<string, number>;
} {
  const writes: Record<string, string> = {};
  const chmods: Record<string, number> = {};
  const realHome = "/fake/realhome";
  const files: Record<string, string> = {
    [join(realHome, ".claude.json")]: JSON.stringify({
      oauthAccount: { emailAddress: "tim@x.dev" },
      userID: "user-123",
      hasCompletedOnboarding: false,
      // A key that must NOT be copied (proves the subset is selective).
      projects: { "/some/path": { history: ["secret"] } },
    }),
  };
  const deps: IdentityDeps = {
    readFile: (p) => {
      if (files[p] === undefined) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    writeFile: (p, c) => {
      writes[p] = c;
    },
    mkdir: () => {},
    chmod: (p, m) => {
      chmods[p] = m;
    },
    readCredentials: () => "keychain-oauth-blob\n",
    realHome: () => realHome,
    ...overrides,
  };
  return { deps, writes, chmods };
}

describe("seedClaudeIdentity", () => {
  it("writes ONLY the identity subset + credentials (never the whole ~/.claude.json)", () => {
    const { deps, writes, chmods } = fakeDeps();
    const dir = "/outside/workspace/claude-config";
    const res = seedClaudeIdentity(dir, deps);

    const claudeJson = JSON.parse(writes[join(dir, ".claude.json")]);
    // hasCompletedOnboarding is forced true; oauthAccount/userID copied.
    expect(claudeJson.hasCompletedOnboarding).toBe(true);
    expect(claudeJson.userID).toBe("user-123");
    expect(claudeJson.oauthAccount).toEqual({ emailAddress: "tim@x.dev" });
    // The unrelated `projects` history is NEVER copied.
    expect(claudeJson.projects).toBeUndefined();
    // All three identity keys are present in the source, so all three are copied.
    expect(res.copiedKeys.sort()).toEqual([...IDENTITY_KEYS].sort());

    // Credentials land at .credentials.json, chmod 600.
    const credPath = join(dir, ".credentials.json");
    expect(writes[credPath].trim()).toBe("keychain-oauth-blob");
    expect(chmods[credPath]).toBe(0o600);
  });

  it("uses the right keychain service name", () => {
    let asked = "";
    const { deps } = fakeDeps({
      readCredentials: () => {
        asked = CREDENTIALS_SERVICE;
        return "blob";
      },
    });
    seedClaudeIdentity("/x", deps);
    expect(asked).toBe("Claude Code-credentials");
  });

  it("throws a clear error when ~/.claude.json is missing", () => {
    const { deps } = fakeDeps({
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(() => seedClaudeIdentity("/x", deps)).toThrow(/log into Claude Code/);
  });

  it("throws when the identity keys are absent (not logged in)", () => {
    const { deps } = fakeDeps({
      readFile: () => JSON.stringify({ hasCompletedOnboarding: true }),
    });
    expect(() => seedClaudeIdentity("/x", deps)).toThrow(/no oauthAccount\/userID/);
  });

  it("throws when the keychain read is empty", () => {
    const { deps } = fakeDeps({ readCredentials: () => "  \n" });
    expect(() => seedClaudeIdentity("/x", deps)).toThrow(/keychain read.*empty/);
  });
});
