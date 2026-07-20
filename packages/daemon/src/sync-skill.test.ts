/**
 * The bundled skill that ships in the npm tarball must be EXACTLY the public
 * surface — SKILL.md + references/{create,update,evolve,run}.md — and nothing else.
 * The server's src/skill/ also holds INTERNAL run prompts under run/ (exec-loop,
 * edit) that are server-side run-dispatch only; a naive recursive copy would leak
 * them into every user's installed ./.claude/skills/loopany/. This runs the real
 * sync-skill.mjs and asserts the selectivity (guards against a regression to
 * `cpSync(src, dst, {recursive})`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const script = path.join(root, "scripts", "sync-skill.mjs");
const bundle = path.join(root, "skill");

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

test("sync-skill bundles ONLY the public surface (no internal run prompts)", () => {
  execFileSync("node", [script], { stdio: "pipe" });
  const files = listTree(bundle);
  expect(files).toEqual(["SKILL.md", "references/create.md", "references/update.md", "references/evolve.md", "references/run.md"].sort());
  // Explicitly: the internal run prompts never reach the tarball.
  expect(files).not.toContain("run/exec-loop.md");
  expect(files).not.toContain("run/edit.md");
  expect(files.some((f) => f.startsWith("run/"))).toBe(false);
  // And the server-only first-capture onboarding doc (served at /api/skill) is NOT
  // an installable skill file, so it must never ship in the bundle either.
  expect(files).not.toContain("bootstrap.md");
  // The template-market docs (skill/templates/*) are PUBLIC-served (like bootstrap.md)
  // but not installable — they must never leak into the tarball either.
  expect(files.some((f) => f.startsWith("templates/"))).toBe(false);
});

/**
 * STALENESS GUARD. `packages/daemon/skill/` is a build artifact, but it is also what
 * `loopany skill install` copies onto a user's machine — so a checkout whose bundle
 * predates the source silently installs OLD instructions into every coding agent.
 * That really happened (2026-07-20): a Jul-14 bundle kept installing a superseded
 * skill describing a different task-folder convention and a CLI API the shipped
 * binary doesn't have, and a template setup run followed it instead of the source.
 * The selectivity test above passes happily in that state, because it re-runs the
 * sync first. This one compares BYTES as committed/checked-out — run sync-skill
 * (i.e. `pnpm --filter @crewlet/loopany build`) whenever the skill source changes.
 */
test("the bundled skill is not stale (bytes match src/skill's public surface)", () => {
  const src = path.resolve(root, "..", "server", "src", "skill");
  for (const rel of ["SKILL.md", "references/create.md", "references/update.md", "references/evolve.md", "references/run.md"]) {
    const bundled = fs.readFileSync(path.join(bundle, rel), "utf8");
    const source = fs.readFileSync(path.join(src, rel), "utf8");
    expect(bundled, `${rel} is stale — re-run the daemon build to re-sync`).toBe(source);
  }
});
