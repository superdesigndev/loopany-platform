/**
 * CODEX IDENTITY seeding for the codex real-agent tier (the same discipline as
 * claudeIdentity.ts): codex resolves its state dir from CODEX_HOME, so seeding
 * is ONE file - the real ~/.codex/auth.json copied into a sandbox-external dir
 * (chmod 600). The real config.toml is deliberately NOT copied: it carries the
 * user's hooks/notify/computer-use wiring, and a clean CODEX_HOME isolates all
 * of it (codex runs fine on defaults; the exec flags carry the sandbox bypass).
 *
 * ALL external touches are injectable seams (fs, the real home path), so unit
 * tests never read the real ~/.codex. The seeded dir MUST live OUTSIDE the
 * workspace/ that snapshots copy - the runner passes such a dir.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Injectable seams. Defaults touch the REAL fs/home; tests pass fakes. */
export interface CodexIdentityDeps {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  mkdir: (path: string) => void;
  chmod: (path: string, mode: number) => void;
  realHome: () => string;
}

export const realCodexIdentityDeps: CodexIdentityDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, contents) => writeFileSync(path, contents),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  chmod: (path, mode) => chmodSync(path, mode),
  realHome: () => homedir(),
};

/** Seed `codexHome` so `codex exec` authenticates under a fake HOME. Throws a
 *  clear error when the machine has no codex login - the caller surfaces the
 *  `codex login` fix hint. */
export function seedCodexIdentity(
  codexHome: string,
  deps: CodexIdentityDeps = realCodexIdentityDeps,
): { codexHome: string } {
  const source = join(deps.realHome(), ".codex", "auth.json");
  let raw: string;
  try {
    raw = deps.readFile(source);
  } catch {
    throw new Error(`cannot read ${source} - log into codex on this machine first (\`codex login\`)`);
  }
  try {
    JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON - re-run \`codex login\``);
  }

  deps.mkdir(codexHome);
  const dest = join(codexHome, "auth.json");
  deps.writeFile(dest, raw);
  deps.chmod(dest, 0o600);
  return { codexHome };
}
