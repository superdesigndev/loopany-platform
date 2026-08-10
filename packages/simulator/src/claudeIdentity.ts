/**
 * CLAUDE IDENTITY seeding for the real-agent tier (tier b/c in §4 of the design
 * doc). The engine calls this ONLY when the caller opts into a real-agent tier;
 * the replay tier never touches it.
 *
 * The recipe is EMPIRICALLY VERIFIED on macOS (see the P1 task notes): claude's
 * logged-in gate follows CLAUDE_CONFIG_DIR. With a custom config dir it reads
 * `<dir>/.credentials.json` (the keychain only serves the DEFAULT config dir), so
 * seeding is two files:
 *
 *   <dir>/.claude.json       = ONLY { oauthAccount, userID, hasCompletedOnboarding }
 *                              copied from the real ~/.claude.json
 *   <dir>/.credentials.json  = stdout of
 *                              `security find-generic-password -s "Claude Code-credentials" -w`
 *                              (chmod 600)
 *
 * With a fake HOME + this config dir, `claude -p` authenticates and is naturally
 * isolated from the user's global CLAUDE.md / hooks / skills.
 *
 * ALL external touches are injectable seams (fs, the `security` exec, the real
 * home path), so unit tests drive fakes and NEVER read the real keychain/home.
 * The seeded config dir MUST live OUTSIDE the workspace/ that snapshots copy, so
 * credentials can never land in a snapshot - the engine passes such a dir.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The subset of ~/.claude.json a seeded config dir needs. Only these keys are
 *  copied - never the whole file (which carries unrelated project history). */
export const IDENTITY_KEYS = ["oauthAccount", "userID", "hasCompletedOnboarding"] as const;

/** The keychain service name claude stores its OAuth credentials under. */
export const CREDENTIALS_SERVICE = "Claude Code-credentials";

/** Injectable seams. Defaults touch the REAL fs / keychain / home; tests pass
 *  fakes so nothing real is read. */
export interface IdentityDeps {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  mkdir: (path: string) => void;
  chmod: (path: string, mode: number) => void;
  /** Read the keychain credentials blob (the `security find-generic-password`
   *  stdout). Kept a seam so a test never invokes `security`. */
  readCredentials: () => string;
  /** The real user's home dir, where the source ~/.claude.json lives. */
  realHome: () => string;
}

export const realIdentityDeps: IdentityDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, contents) => writeFileSync(path, contents),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  chmod: (path, mode) => chmodSync(path, mode),
  readCredentials: () =>
    execFileSync("security", ["find-generic-password", "-s", CREDENTIALS_SERVICE, "-w"], {
      encoding: "utf8",
    }),
  realHome: () => homedir(),
};

/** What the caller learns about a seed (for the preflight report). */
export interface SeedResult {
  configDir: string;
  /** The identity keys actually found + copied (a real ~/.claude.json has all). */
  copiedKeys: string[];
}

/** Seed `configDir` so `claude -p` authenticates under a fake HOME. Throws a
 *  clear error if the real ~/.claude.json is missing the identity keys or the
 *  keychain read yields nothing - the caller surfaces the fix hint. */
export function seedClaudeIdentity(configDir: string, deps: IdentityDeps = realIdentityDeps): SeedResult {
  const source = join(deps.realHome(), ".claude.json");
  let raw: string;
  try {
    raw = deps.readFile(source);
  } catch {
    throw new Error(
      `cannot read ${source} - log into Claude Code on this machine first (\`claude\`)`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }

  // hasCompletedOnboarding is FORCED true (never copied - a source value of false
  // would re-gate the seeded dir). oauthAccount + userID are copied verbatim.
  const identity: Record<string, unknown> = { hasCompletedOnboarding: true };
  const copiedKeys: string[] = ["hasCompletedOnboarding"];
  for (const key of IDENTITY_KEYS) {
    if (key === "hasCompletedOnboarding") continue;
    if (parsed[key] !== undefined) {
      identity[key] = parsed[key];
      copiedKeys.push(key);
    }
  }
  if (!copiedKeys.includes("oauthAccount") || !copiedKeys.includes("userID")) {
    throw new Error(
      `${source} has no oauthAccount/userID - is this machine logged into Claude Code?`,
    );
  }

  const credentials = deps.readCredentials().trim();
  if (credentials.length === 0) {
    throw new Error(
      `keychain read for "${CREDENTIALS_SERVICE}" was empty - is Claude Code logged in?`,
    );
  }

  deps.mkdir(configDir);
  deps.writeFile(join(configDir, ".claude.json"), JSON.stringify(identity, null, 2) + "\n");
  const credPath = join(configDir, ".credentials.json");
  deps.writeFile(credPath, credentials + "\n");
  deps.chmod(credPath, 0o600);

  return { configDir, copiedKeys };
}
