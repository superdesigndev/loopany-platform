/**
 * Copy the canonical loopany skill from the server package into this daemon
 * package so it ships in the published npm tarball (package.json `files` includes
 * `skill`). Run on `build` and `prepublishOnly` so the bundled copy can never
 * drift from the single source of truth at packages/server/src/skill/.
 *
 * The daemon installs this bundled dir locally via `npx skills` during `loopany up`
 * (see src/skill-install.ts) — a LOCAL path source, so end users never need the
 * (private) platform repo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "server", "src", "skill");
const dst = path.resolve(here, "..", "skill");

if (!fs.existsSync(path.join(src, "SKILL.md"))) {
  // Not fatal: the daemon install path is best-effort and degrades when the
  // bundled skill is absent. Warn loudly so a real build notices a broken layout.
  console.warn(`sync-skill: source skill not found at ${src} — skipping (bundled skill will be absent)`);
  process.exit(0);
}

fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`sync-skill: ${src} -> ${dst}`);
