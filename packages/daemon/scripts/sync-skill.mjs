/**
 * Copy the canonical loopany skill from the server package into this daemon
 * package so it ships in the published npm tarball (package.json `files` includes
 * `skill`). Run on `build` and `prepublishOnly` so the bundled copy can never
 * drift from the single source of truth at packages/server/src/skill/.
 *
 * SELECTIVE COPY — only the PUBLIC skill surface ships: SKILL.md (installable skill
 * root) + the references/ quartet (create/update/evolve authoring + run runtime
 * protocol). The INTERNAL run prompts under skill/run/ (exec-loop, edit) are
 * server-side run-dispatch ONLY,
 * bootstrap.md is the SERVER-ONLY first-capture onboarding doc served at /api/skill
 * (not an installable skill file), and skill/templates/ is the template-market
 * metadata (public-served via listTemplates, not an installable skill file) — none of
 * these may reach the public npm tarball or a user's installed
 * ./.claude/skills/loopany/. A naive `cpSync(src, dst, {recursive})` would copy run/,
 * bootstrap.md AND templates/ too — so we whitelist instead.
 *
 * The daemon installs this bundled dir locally via `npx skills` during `loopany new`
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

// The exact public surface — nothing else (notably NOT skill/run/ or bootstrap.md) is bundled.
const PUBLIC = ["SKILL.md", path.join("references", "create.md"), path.join("references", "update.md"), path.join("references", "evolve.md"), path.join("references", "run.md")];

fs.rmSync(dst, { recursive: true, force: true });
for (const rel of PUBLIC) {
  const from = path.join(src, rel);
  const to = path.join(dst, rel);
  if (!fs.existsSync(from)) {
    console.warn(`sync-skill: expected public skill file missing at ${from} — skipping it`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log(`sync-skill: ${src} -> ${dst} (public surface only: SKILL.md + references/)`);
