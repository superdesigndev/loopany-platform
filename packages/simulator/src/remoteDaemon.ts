/**
 * The REMOTE tier's daemon driver (kernel-real-daemon-simulator): one tick
 * phase = one `pumpUntilDry` over the PRODUCTION kernel lifecycle - the same
 * poll body (kernelInFlight always real, never `[]` lies), the same dispatch/
 * dedup, the same runKernelDelivery (spawn, one retry, agent-session
 * extraction, the finish retry ladder). The simulator owns ONLY orchestration:
 * virtual time, the executor binary, and the finish envelope's sim time
 * authority - each injected through the lifecycle's explicit seams, never a
 * second protocol implementation.
 *
 * Runs as a subprocess per tick (tsx; the engine stays sync). Env contract
 * (the engine threads the sandbox env + per-tick keys):
 *   LOOPANY_KERNEL_BACKEND / LOOPANY_KERNEL_TOKEN   server + dk_ device token
 *   LOOPANY_SIM_ALIAS                               machine alias
 *   LOOPANY_NOW                                     the virtual instant
 *   LOOPANY_KERNEL_SIM_AUTHORITY                    the time-authority capability
 *   LOOPANY_SIM_CLAUDE_BIN                          the claude-slot executable
 *   (+ the sandbox allowlist: PATH/HOME/replay-script/... - forwarded to the
 *    spawned agent verbatim via the lifecycle's agentEnv seam)
 */
import { hostname } from "node:os";
import { KernelLifecycle } from "../../daemon/src/kernel-lifecycle.js";
import { realKernelRunDeps, type KernelRunDeps } from "../../daemon/src/kernel-run.js";

const BASE = process.env.LOOPANY_KERNEL_BACKEND;
const TOKEN = process.env.LOOPANY_KERNEL_TOKEN;
const ALIAS = process.env.LOOPANY_SIM_ALIAS ?? "sim";
const NOW = process.env.LOOPANY_NOW;
const SIM_AUTHORITY = process.env.LOOPANY_KERNEL_SIM_AUTHORITY;

if (!BASE || !TOKEN) {
  process.stderr.write("remoteDaemon: needs LOOPANY_KERNEL_BACKEND + LOOPANY_KERNEL_TOKEN\n");
  process.exit(2);
}

// The executor: buildAgentSpawn reads LOOPANY_CLAUDE_BIN, so the scenario's
// claude-slot binary (the replay shim, or the real claude) is bound here.
if (process.env.LOOPANY_SIM_CLAUDE_BIN) {
  process.env.LOOPANY_CLAUDE_BIN = process.env.LOOPANY_SIM_CLAUDE_BIN;
}

// The agent inherits the driver's env VERBATIM - the driver's env IS the
// sandbox's hermetic allowlist (fake HOME, shims-first PATH, replay script,
// virtual clock, sim authority), which is exactly what the agent must see.
const agentEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) agentEnv[k] = v;

// The finish seam: the production retry ladder calls THIS per attempt - the
// driver only reshapes the envelope so run-finish rides the virtual clock
// under the sim time authority. Everything else is realKernelRunDeps.
const deps: KernelRunDeps = {
  ...realKernelRunDeps,
  agentEnv,
  finish: async (serverUrl, runToken, body) => {
    const envelope = {
      ...(body as Record<string, unknown>),
      ...(NOW ? { now: NOW } : {}),
      ...(SIM_AUTHORITY ? { simAuthority: SIM_AUTHORITY } : {}),
    };
    await realKernelRunDeps.finish(serverUrl, runToken, envelope);
  },
};

const lifecycle = new KernelLifecycle({
  server: BASE,
  token: TOKEN,
  info: { host: hostname(), alias: ALIAS },
  roots: [], // the sandbox jail is the engine's containment; workdirs are sandbox-local
  runDeps: deps,
});

const report = await lifecycle.pumpUntilDry();
process.stdout.write(JSON.stringify(report) + "\n");
process.exit(0);
