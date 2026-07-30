#!/usr/bin/env node
/**
 * `loopany-agent` - run the machine agent.
 *
 *   loopany-agent            poll forever (effects + sensing)
 *   loopany-agent --once     one effects pass and one sensing sweep, then exit
 *   loopany-agent --sense    one sensing sweep only, then exit
 *   loopany-agent --help
 *
 * Configuration is environment only, and the posture it resolves to is PRINTED at
 * start - "what was this agent allowed to do?" should be answerable from the terminal
 * scrollback, not from reconstructing the env of a process that has since exited.
 */
import { describeConfig, loadConfig } from "./config.js";
import { defaultDeps, pollOnce, runAgent, sensePeriod } from "./agent.js";

const USAGE = `loopany-agent — the machine side of the graph engine

Senses the outside world with local credentials, executes approved outward-effect
work orders, and runs approved instructions in a sandbox. The server does none of
these things; it stores the graph and hands out work.

  loopany-agent            poll forever (effects every few seconds, sensing on its own cadence)
  loopany-agent --once     one effects pass + one sensing sweep, then exit
  loopany-agent --sense    one sensing sweep only, then exit

Wire:
  LOOPANY_AGENT_SERVER_URL            the Loopany server (required)
  LOOPANY_AGENT_TOKEN                 shared secret for /api/agent/* (required)
  LOOPANY_AGENT_ID                    this instance's id (default: machine-agent-<pid>)
  LOOPANY_AGENT_MACHINE               match work orders bound to this machine
  LOOPANY_AGENT_TEAM                  graph team to serve (default: the demo team)
  LOOPANY_AGENT_POLL_MS               effects cadence (default 3000)

GitHub effects — EVERY GUARD FAILS CLOSED:
  LOOPANY_AGENT_ALLOWED_REPOS         "owner/name, owner/other" — EMPTY ALLOWS NOTHING
  LOOPANY_AGENT_ALLOW_DEFAULT_BRANCH  set to allow merging into a repo's DEFAULT branch
  LOOPANY_AGENT_COMMENT_ONLY          refuse every merge, whatever the allowlist says
  LOOPANY_AGENT_GH_BIN                path to the gh CLI (default: gh)

Sensing (captain decision 10 — nothing else observes the world):
  LOOPANY_AGENT_SENSING               set to "off" to stop sensing (ON by default)
  LOOPANY_AGENT_SENSING_MS            sweep cadence (default 120000)

Instruction runs (captain decision 12 — the default path for external effects):
  LOOPANY_AGENT_EXEC_COMMAND          the executor that receives an instruction on
                                      stdin (a coding agent, or a bounded script).
                                      UNSET means this machine runs NOTHING.
  LOOPANY_AGENT_EXEC_ARGS             fixed arguments prepended to every invocation
  LOOPANY_AGENT_RUN_ROOT              the JAIL every run works inside. UNSET means
                                      this machine runs NOTHING.
  LOOPANY_AGENT_RUN_MAX_TIMEOUT_MS    ceiling on a work order's timeout (default 900000)
  LOOPANY_AGENT_RUN_MAX_OUTPUT_BYTES  captured output per run (default 262144)

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
  deps.log(`loopany machine agent\n  ${describeConfig(config)}\n`);
  // Loud, and not fatal: an agent with no allowlist and no executor is a legitimate
  // posture (it proves the channel works while acting on nothing), but it must never
  // look like a working one.
  if (!config.allowedRepos.size) {
    deps.log("! the repo allowlist is EMPTY, so every GitHub effect will refuse. Set LOOPANY_AGENT_ALLOWED_REPOS.");
  }
  if (!config.run.command || !config.run.root) {
    deps.log(
      "! no instruction executor and/or no run root, so every run will refuse. " +
        "Set LOOPANY_AGENT_EXEC_COMMAND and LOOPANY_AGENT_RUN_ROOT.",
    );
  }
  if (!config.sensing) {
    deps.log("! sensing is OFF, so nothing will keep this workspace's mirrors fresh (LOOPANY_AGENT_SENSING).");
  }
  deps.log("");

  if (argv.includes("--sense")) {
    const sweep = await sensePeriod(config, deps);
    deps.log(`\nwatched ${sweep.watched} · changed ${sweep.changed} · events ${sweep.events}`);
    return;
  }

  if (argv.includes("--once")) {
    const r = await pollOnce(config, deps);
    deps.log(`\nclaimed ${r.claimed} · done ${r.done} · failed ${r.failed}`);
    if (config.sensing) await sensePeriod(config, deps);
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
  process.stderr.write(`machine agent failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
