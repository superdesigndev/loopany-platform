/**
 * The scenario RUNNER entry (§4 tiers a/b): drives a scenario against a sandbox
 * on the chosen agent tier and prints a per-day progress line + a final summary.
 *
 *   npx tsx src/run.ts <scenario> --tier replay|haiku|sonnet|codex --run-id <id> [--dir <sandbox>]
 *
 * Tier `replay` runs the scenario's replay script (zero-cost, deterministic - no
 * identity work). Tier `haiku` seeds the claude identity into a config dir OUTSIDE
 * the workspace (so snapshots never capture credentials), runs an identity smoke
 * preflight, and binds the `claude` assignee to the real claude with the haiku
 * model. The orchestrator runs the real haiku pass; this file's haiku path is
 * exercised in tests only through injected fakes (never a real API call).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "@loopany/cli";
import { runScenario } from "./engine.js";
import { readRecordedPrs } from "./probe.js";
import { seedClaudeIdentity, realIdentityDeps, type IdentityDeps } from "./claudeIdentity.js";
import { seedCodexIdentity, type CodexIdentityDeps } from "./codexIdentity.js";
import type { Scenario, SimResult } from "./types.js";
import {
  miniW3Scenario,
  MINI_W3_REPLAY,
  RELEASE_RADAR_ID,
} from "../scenarios/mini-w3.js";
import { seoScaleScenario, SEO_SCALE_REPLAY } from "../scenarios/seo-scale.js";
import { replayAgentPath, smokeSeoScenario } from "../scenarios/smoke-seo.js";

export type Tier = "replay" | "haiku" | "sonnet" | "codex";

/** Real-agent model ids per tier (the CLI accepts the full name; short aliases
 *  vary by claude version, so full ids are the safe choice). haiku is the
 *  default abrasive tier (weaknesses surface faster and cheaper); sonnet is the
 *  A/B control - when a haiku finding might be model-capability noise rather
 *  than a mechanism gap, the same scenario on sonnet distinguishes the two. */
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-6";

/** Build the `claude` executor Profile for a tier. Replay -> the replay shim (the
 *  scenario's replayScript drives it). haiku/sonnet -> the real claude, print
 *  mode, the prompt on argv, WebFetch/WebSearch disallowed (the sandbox has no
 *  network world beyond the mirrors). CLAUDE_CONFIG_DIR is NOT a profile field
 *  (spawn.ts builds the child env from the sandbox base env, not the profile) -
 *  it rides the scenario's extraEnv (see runCli). */
export function agentProfileFor(tier: Tier): Profile {
  if (tier === "replay") {
    return { cmd: process.execPath, args: [replayAgentPath()] };
  }
  if (tier === "codex") {
    // Containment is OUR sandbox rings (fake HOME, PATH shims, env allowlist,
    // branch-protected origin) - codex's own sandbox would block the workspace
    // writes, so it is bypassed. No -m: the account default model is the point
    // of the A/B. The workspace is not a git repo, hence --skip-git-repo-check.
    return {
      cmd: process.env.LOOPANY_CODEX_BIN ?? "codex",
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "{{prompt}}",
      ],
    };
  }
  return {
    cmd: process.env.LOOPANY_CLAUDE_BIN ?? "claude",
    args: [
      "-p",
      "{{prompt}}",
      "--model",
      tier === "sonnet" ? SONNET_MODEL : HAIKU_MODEL,
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "WebFetch",
      "WebSearch",
    ],
  };
}

/** The scenario registry (one for P1). The `<scenario>` arg keys into it. */
function selectScenario(name: string, tier: Tier): Scenario {
  const key = name.replace(/.*\//, "").replace(/\.(ts|js)$/, "");
  if (key === "smoke-seo") {
    // The 3-day mechanism smoke - replay-only by construction (its profiles map
    // the `replay` assignee onto the replay shim).
    if (tier !== "replay") throw new Error("smoke-seo is a replay-tier scenario");
    return smokeSeoScenario();
  }
  if (key === "mini-w3") {
    const scenario = miniW3Scenario(agentProfileFor(tier));
    // Only the replay tier gets a replay script wired.
    return tier === "replay" ? { ...scenario, replayScript: MINI_W3_REPLAY } : scenario;
  }
  if (key === "seo-scale") {
    const scenario = seoScaleScenario(agentProfileFor(tier));
    return tier === "replay" ? { ...scenario, replayScript: SEO_SCALE_REPLAY } : scenario;
  }
  throw new Error(`unknown scenario "${name}" (known: smoke-seo, mini-w3, seo-scale)`);
}

/** Deps the runner injects (so tests never seed a real identity or spawn claude). */
export interface RunnerDeps {
  seedIdentity: (configDir: string, deps?: IdentityDeps) => { copiedKeys: string[] };
  /** The identity smoke: run `claude -p` once and return its exit code. Injected
   *  so a test asserts the preflight path without a real API call. */
  smoke: (configDir: string, home: string) => { status: number; stderr: string };
  /** Codex-tier seams (optional: replay/claude-tier callers never touch them;
   *  the codex branch falls back to the real implementations when absent). */
  seedCodex?: (codexHome: string, deps?: CodexIdentityDeps) => { codexHome: string };
  codexSmoke?: (codexHome: string, home: string) => { status: number; stderr: string };
  log: (line: string) => void;
}

export const realRunnerDeps: RunnerDeps = {
  seedIdentity: (configDir, deps) => seedClaudeIdentity(configDir, deps),
  smoke: (configDir, home) => {
    const child = spawnSync(process.env.LOOPANY_CLAUDE_BIN ?? "claude", [
      "-p",
      "reply OK",
      "--model",
      HAIKU_MODEL,
    ], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir },
      encoding: "utf8",
    });
    return { status: child.status ?? 1, stderr: child.stderr ?? "" };
  },
  seedCodex: (codexHome, deps) => seedCodexIdentity(codexHome, deps),
  codexSmoke: (codexHome, home) => {
    const child = spawnSync(
      process.env.LOOPANY_CODEX_BIN ?? "codex",
      ["exec", "--skip-git-repo-check", "reply OK"],
      { env: { ...process.env, HOME: home, CODEX_HOME: codexHome }, encoding: "utf8" },
    );
    return { status: child.status ?? 1, stderr: child.stderr ?? "" };
  },
  log: (line) => process.stdout.write(line + "\n"),
};

export interface RunnerOpts {
  scenario: string;
  tier: Tier;
  runId: string;
  dir?: string;
  /** REMOTE tier: the deployed server's base URL. The runner derives a
   *  deterministic device token + machine alias from the runId (the disposable
   *  testing deployment resets its DB on restart, so no cross-run collision
   *  management is needed). */
  remote?: string;
}

/** Run a scenario. For the haiku tier this seeds the identity + runs the smoke
 *  preflight (failing loud with the fix hint) before the scenario. Returns the
 *  SimResult; the caller (main) prints the summary. */
export function runCli(opts: RunnerOpts, deps: RunnerDeps = realRunnerDeps): SimResult {
  const sandboxDir = opts.dir; // when undefined, the engine mkdtemps its own root

  let claudeConfigDir: string | undefined;
  if (opts.tier === "haiku" || opts.tier === "sonnet") {
    // The seeded config dir MUST live OUTSIDE the workspace so snapshots (which
    // copy workspace/.loopany + workspace/mirrors) never capture credentials.
    // We place it under the OS tmp, keyed by run id.
    claudeConfigDir = join(tmpdir(), `loopany-sim-claude-${opts.runId}`);
    mkdirSync(claudeConfigDir, { recursive: true });
    deps.log(`identity: seeding ${claudeConfigDir}`);
    deps.seedIdentity(claudeConfigDir);
    // The smoke uses a throwaway HOME (never the real one) - the seeded config
    // dir is what authenticates.
    const smokeHome = join(tmpdir(), `loopany-sim-smokehome-${opts.runId}`);
    mkdirSync(smokeHome, { recursive: true });
    const smoke = deps.smoke(claudeConfigDir, smokeHome);
    if (smoke.status !== 0) {
      throw new Error(
        `claude identity preflight FAILED (exit ${smoke.status}): ${smoke.stderr}\n` +
          "fix: log into Claude Code on this machine (\`claude\`), then retry - the " +
          "seed copies ~/.claude.json identity + the keychain credentials.",
      );
    }
    deps.log("identity: OK");
  }

  let codexHome: string | undefined;
  if (opts.tier === "codex") {
    // Same discipline as the claude tiers: the seeded dir lives OUTSIDE the
    // workspace so snapshots never capture auth.json.
    codexHome = join(tmpdir(), `loopany-sim-codex-${opts.runId}`);
    deps.log(`identity: seeding ${codexHome}`);
    (deps.seedCodex ?? seedCodexIdentity)(codexHome);
    const smokeHome = join(tmpdir(), `loopany-sim-smokehome-${opts.runId}`);
    mkdirSync(smokeHome, { recursive: true });
    const smoke = (deps.codexSmoke ?? realRunnerDeps.codexSmoke!)(codexHome, smokeHome);
    if (smoke.status !== 0) {
      throw new Error(
        `codex identity preflight FAILED (exit ${smoke.status}): ${smoke.stderr}\n` +
          "fix: log into codex on this machine (\`codex login\`), then retry - the " +
          "seed copies ~/.codex/auth.json into a sandbox CODEX_HOME.",
      );
    }
    deps.log("identity: OK");
  }

  const scenario = selectScenario(opts.scenario, opts.tier);

  deps.log(`running ${scenario.name} (tier ${opts.tier}, run ${opts.runId})`);
  // Real tiers thread the seeded auth dir into the child env (spawn.ts inherits
  // the sandbox base env): CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex.
  const extraEnv: Record<string, string> | undefined = claudeConfigDir
    ? { CLAUDE_CONFIG_DIR: claudeConfigDir }
    : codexHome
      ? { CODEX_HOME: codexHome }
      : undefined;
  const remote = opts.remote
    ? {
        base: opts.remote.replace(/\/$/, ""),
        token: `dk_sim_${opts.runId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
        alias: `sim-${opts.runId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24)}`,
      }
    : undefined;
  if (remote) deps.log(`remote: ${remote.base} (machine ${remote.alias})`);
  const result = runScenario(scenario, { runId: opts.runId, dir: sandboxDir, extraEnv, remote });

  for (const day of result.days) {
    const refusals = day.commands.filter((c) => c.exitCode !== 0).length;
    deps.log(
      `  ${day.date}: ${day.commands.length} cmd(s)` +
        (refusals ? `, ${refusals} nonzero` : "") +
        ` -> ${day.snapshotDir}`,
    );
  }

  printSummary(result, deps);
  return result;
}

/** Print the final summary: the task list (from the last snapshot's list), the
 *  refusal count (nonzero exits across all commands), and the audit.log tail. */
function printSummary(result: SimResult, deps: RunnerDeps): void {
  const allCommands = [...result.setup, ...result.days.flatMap((d) => d.commands)];
  const refusals = allCommands.filter((c) => c.exitCode !== 0);
  deps.log("");
  deps.log("=== summary ===");
  deps.log(`commands: ${allCommands.length}, nonzero: ${refusals.length}`);
  if (refusals.length > 0) {
    for (const r of refusals.slice(0, 10)) {
      deps.log(`  nonzero: ${r.label} (exit ${r.exitCode})`);
    }
  }

  // Recorded PRs = whether the fix arc produced a PR (and whether it touched the
  // planted bug file - the recovery gate).
  const sandboxRoot = join(result.workspace, "..");
  const prs = readRecordedPrs(sandboxRoot);
  deps.log(`recorded PRs: ${prs.length}`);
  for (const pr of prs) {
    const touchedBug = pr.changedFiles.some((f) => f.endsWith("public/install-wrapper.js"));
    deps.log(`  #${pr.number} ${pr.branch}${touchedBug ? " (fixes planted bug)" : ""}`);
  }
}

/** Parse argv into RunnerOpts (bare, no dependency on the CLI's parser). */
export function parseRunnerArgv(argv: string[]): RunnerOpts {
  const scenario = argv[0];
  if (!scenario || scenario.startsWith("--")) {
    throw new Error("usage: run.ts <scenario> --tier replay|haiku|sonnet|codex --run-id <id> [--dir <sandbox>]");
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tier = (flag("tier") ?? "replay") as Tier;
  if (tier !== "replay" && tier !== "haiku" && tier !== "sonnet" && tier !== "codex") throw new Error(`--tier must be replay|haiku|sonnet|codex, got "${tier}"`);
  const runId = flag("run-id") ?? `${scenario.replace(/.*\//, "").replace(/\.(ts|js)$/, "")}-${tier}`;
  return { scenario, tier, runId, dir: flag("dir"), remote: flag("remote") };
}

// CLI entry: `tsx src/run.ts ...`.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runCli(parseRunnerArgv(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
