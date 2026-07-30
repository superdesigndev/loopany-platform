#!/usr/bin/env node
/**
 * `loopany-effects` - run the effect agent.
 *
 *   loopany-effects            poll forever
 *   loopany-effects --once     one pass, then exit (a check, or a demo step)
 *   loopany-effects --help
 *
 * Configuration is environment only, and the posture it resolves to is PRINTED
 * at start - "what was this agent allowed to do?" should be answerable from the
 * terminal scrollback, not from reconstructing the env of a process that has
 * since exited.
 */
import { describeConfig, loadConfig } from "./config.js";
import { defaultDeps, pollOnce, runAgent } from "./agent.js";

const USAGE = `loopany-effects — claim approved outward effects and execute them locally

  loopany-effects            poll the directive channel forever
  loopany-effects --once     run one pass and exit

Environment:
  LOOPANY_EFFECT_SERVER_URL           the Loopany server (required)
  LOOPANY_EFFECT_AGENT_TOKEN          shared secret for /api/effects/* (required)
  LOOPANY_EFFECT_ALLOWED_REPOS        "owner/name, owner/other" — EMPTY ALLOWS NOTHING
  LOOPANY_EFFECT_ALLOW_DEFAULT_BRANCH set to allow merging into a repo's DEFAULT branch
  LOOPANY_EFFECT_COMMENT_ONLY         refuse every merge, whatever the allowlist says
  LOOPANY_EFFECT_AGENT_ID             this instance's id (default: effect-agent-<pid>)
  LOOPANY_EFFECT_MACHINE              match directives bound to this machine
  LOOPANY_EFFECT_TEAM                 graph team to poll (default: the demo team)
  LOOPANY_EFFECT_POLL_MS              poll cadence (default 3000)
  LOOPANY_GH_BIN                      path to the gh CLI (default: gh)

GitHub credentials are gh's own. This agent never reads, stores or forwards one.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(2);
    return;
  }

  const deps = defaultDeps();
  deps.log(`loopany effect agent\n  ${describeConfig(config)}\n`);
  if (!config.allowedRepos.size) {
    // Loud, and not fatal: an agent with no allowlist is a legitimate posture (it
    // proves the channel works while acting on nothing), but it must never look
    // like a working one.
    deps.log("! the repo allowlist is EMPTY, so every effect will refuse. Set LOOPANY_EFFECT_ALLOWED_REPOS.\n");
  }

  if (argv.includes("--once")) {
    const r = await pollOnce(config, deps);
    deps.log(`\nclaimed ${r.claimed} · done ${r.done} · failed ${r.failed}`);
    return;
  }

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      deps.log("\nstopping.");
      controller.abort();
    });
  }
  await runAgent(config, deps, { signal: controller.signal });
}

main().catch((err: unknown) => {
  process.stderr.write(`effect agent failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
