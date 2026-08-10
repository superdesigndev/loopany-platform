/**
 * SANDBOX construction - a one-shot temp workspace the engine drives.
 *
 * A sandbox is a temp dir holding `workspace/` (an `lk init --no-register`
 * kernel workspace whose config carries the scenario's profiles) and `home/` (a
 * fake HOME so nothing the run does can touch the real `~/.loopany` / registry).
 *
 * Env construction is an EXPLICIT ALLOWLIST, never a `process.env` spread: the
 * child CLI + the agents it spawns must not inherit ambient secrets or a stray
 * LOOPANY_* that would steer them. `LOOPANY_NOW` is set PER TICK by the engine
 * (not here), so the allowlist here carries only the durable keys.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profiles } from "@loopany/cli";

/** Absolute path to the `loopany-kernel` bin, resolved RELATIVE to this package
 *  (never a hardcoded absolute) so the simulator works from any checkout. From
 *  packages/simulator/src -> ../../cli/bin/loopany-kernel.mjs. */
export function kernelBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "cli", "bin", "loopany-kernel.mjs");
}

/** The packaged shims dir (fake `gh`, replay-agent). Resolved relative to this
 *  module so it lands under packages/simulator regardless of process cwd. */
export function packagedShimsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "shims");
}

/** The packaged fixtures dir (the W3 stand-in repo). */
export function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "fixtures");
}

export interface Sandbox {
  /** The temp root holding `workspace/` + `home/`. */
  root: string;
  /** The kernel workspace dir (`<root>/workspace`) - the CLI's cwd. */
  workspace: string;
  /** The fake HOME (`<root>/home`). */
  home: string;
  /** The base env every CLI/agent invocation gets (before per-tick LOOPANY_NOW). */
  env: Record<string, string>;
}

export interface SandboxOpts {
  /** An explicit sandbox root. Defaults to a fresh `mkdtemp`. */
  dir?: string;
  /** The scenario's executor profiles, written into the workspace config. */
  profiles: Profiles;
  /** EXTRA env keys layered onto the allowlist (e.g. CLAUDE_CONFIG_DIR for the
   *  real-agent tier). Never a secret in the replay tier. */
  extraEnv?: Record<string, string>;
}

/** Build the base env: an EXPLICIT allowlist. PATH is required so `node` (and any
 *  real agent binary) resolves; HOME is the fake home so the run is hermetic;
 *  `LOOPANY_KERNEL_BIN` lets the replay agent re-invoke the same CLI bin without
 *  re-deriving it (the bin shim also sets this, but the top-level tick is run via
 *  execFile on the .mjs so we seed it here too).
 *
 *  When `sandboxRoot` is given (the engine path), a `<root>/shims` dir is put
 *  FIRST on PATH (ring 2: the fake `gh`) and `LOOPANY_SANDBOX` names the root so
 *  the shims know where to record. The unit-test path omits it and gets the bare
 *  three-key allowlist. */
export function buildEnv(
  home: string,
  extraEnv?: Record<string, string>,
  sandboxRoot?: string,
): Record<string, string> {
  const basePath = process.env.PATH ?? "";
  const env: Record<string, string> = {
    PATH: sandboxRoot ? join(sandboxRoot, "shims") + delimiter + basePath : basePath,
    HOME: home,
    LOOPANY_KERNEL_BIN: kernelBinPath(),
  };
  if (sandboxRoot) env.LOOPANY_SANDBOX = sandboxRoot;
  if (extraEnv) for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  return env;
}

/** Create the sandbox: dirs, ring-1 fake HOME (a `.gitconfig` so git commits
 *  work), ring-2 shims copied under `<root>/shims`, `lk init --no-register`, then
 *  merge the scenario's profiles into the fresh config. `now` pins init's
 *  createdAt deterministically. */
export function createSandbox(opts: SandboxOpts, now: string): Sandbox {
  const root = opts.dir ?? mkdtempSync(join(tmpdir(), "loopany-sim-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  // Ring 1: a fake-HOME gitconfig so commits in the sandbox have an identity and
  // a deterministic default branch (the W3 fix arc commits to the stand-in repo).
  writeGitConfig(home);

  // Ring 2: copy the packaged shims (fake `gh`) into the sandbox so PATH points
  // at a per-sandbox copy (never the packaged tree, which a run must not mutate).
  const shims = join(root, "shims");
  cpSync(packagedShimsDir(), shims, { recursive: true });

  const env = buildEnv(home, opts.extraEnv, root);

  // `lk init --no-register`: a fresh kernel workspace that the resident daemon
  // will NOT auto-tick (the sandbox runs on a virtual clock).
  execFileSync(process.execPath, [kernelBinPath(), "init", "--no-register"], {
    cwd: workspace,
    env: { ...env, LOOPANY_NOW: now },
    encoding: "utf8",
  });

  writeProfiles(workspace, opts.profiles);
  return { root, workspace, home, env };
}

/** Write a minimal `<home>/.gitconfig` (ring 1): a Sim Agent identity + main as
 *  the default branch, so `git commit` works with no interactive prompt. */
function writeGitConfig(home: string): void {
  const config =
    "[user]\n" +
    "\tname = Sim Agent\n" +
    "\temail = sim@loopany.local\n" +
    "[init]\n" +
    "\tdefaultBranch = main\n";
  writeFileSync(join(home, ".gitconfig"), config);
}

/** Plant the W3 stand-in repo into the sandbox so the fix arc is real work
 *  (§3.4). Copies `fixtureDir` into `<root>/repos/<name>`, `git init` + an initial
 *  commit on `main`, then `git clone --bare` to `<root>/remotes/<name>.git` and
 *  points the working repo's origin at that bare path - so the agent's push has a
 *  real remote. Returns the working-tree path (the repo path a release entry
 *  templates in). Git runs under the sandbox env (fake HOME gitconfig), so the
 *  Sim Agent identity + `main` default branch apply. */
export function plantRepo(
  sandbox: Sandbox,
  fixtureDir: string,
  name = "superdesign-web",
): string {
  const repo = join(sandbox.workspace, "..", "repos", name);
  const bare = join(sandbox.root, "remotes", `${name}.git`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(sandbox.root, "remotes"), { recursive: true });
  cpSync(fixtureDir, repo, { recursive: true });

  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, env: sandbox.env, encoding: "utf8" });

  git(["init", "-b", "main"], repo);
  git(["add", "-A"], repo);
  git(["commit", "-m", "initial import (fixture stand-in)"], repo);
  git(["clone", "--bare", repo, bare], sandbox.root);
  git(["remote", "add", "origin", bare], repo);

  // Branch protection, enforced by the WORLD rather than begged for in a brief
  // (haiku-3: the agent pushed the fix straight to origin main and skipped
  // `gh pr create`, so the conditional recovery never saw a PR). The bare origin
  // rejects any direct main push with the same message a protected GitHub repo
  // gives, which forces the branch -> push -> PR path.
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then\n' +
      '    echo "protected branch main: push a feature branch and open a PR (gh pr create)" >&2\n' +
      "    exit 1\n  fi\ndone\nexit 0\n",
  );
  chmodSync(hook, 0o755);

  return repo;
}

/** Merge the scenario's profiles into `.loopany/config.json` (init seeds none for
 *  the sandbox's own PATH, so the scenario is the sole source of truth). */
function writeProfiles(workspace: string, profiles: Profiles): void {
  const configPath = join(workspace, ".loopany", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.profiles = profiles;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
