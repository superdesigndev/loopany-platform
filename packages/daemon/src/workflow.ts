/**
 * Workflow runner (machine-side) — the cheap, deterministic gate. Runs the
 * loop's JS in a separate `node` subprocess (real isolation + wall-clock
 * timeout), with the previous cursor injected as `prev`, global `fetch`, the
 * `agent()` escalation hook, and `tools.call()` (MCP tools) available. Zero LLM
 * by itself; the script opts into the expensive path by calling `agent()`.
 * Ported from c0's scheduler/workflow.ts.
 *
 * Script contract:
 *   - return "text" or { message?, state? } → `message` is the direct message to
 *     the user (no claude); `state` is the persisted cursor (passed back as `prev`).
 *   - agent(message?, data?) → request escalation to claude (handled by the runner
 *     after the script finishes; the task + message + data become claude's context).
 *   - await tools.call("server.tool", args) → call one of this machine's OWN
 *     configured MCP servers (via mcporter) and get its result back as { text, data }.
 *     This folds the mechanical fetch/list/dedup/filter/sort the agent used to redo
 *     every run into deterministic JS. Read-like uses only (phase 1). Throws a clear
 *     error on a missing server / tool / auth / runtime (which the runner turns into an
 *     agent fallback). See mcp-bridge.mjs.
 *   - return nothing and never call agent() → silent tick.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { allowlistEnv, runProcess } from "./spawn.js";

/** File URL of the plain-ESM MCP bridge the workflow subprocess imports (see
 *  mcp-bridge.mjs). Overridable via env so tests can point at a fixture bridge;
 *  read at call time so an override set after module load still applies. */
function mcpBridgeUrl(): string {
  return process.env.ADSCAILE_MCP_BRIDGE || new URL("./mcp-bridge.mjs", import.meta.url).href;
}

/** Extra env keys the user OPTS INTO passing through to the workflow subprocess
 *  (`ADSCAILE_WORKFLOW_ENV=KEY1,KEY2` on the daemon). MCP server configs commonly
 *  resolve credentials from the shell env — mcporter expands `${VAR}`/`$env:VAR`
 *  placeholders against the subprocess env, and stdio server children inherit
 *  it — which the allowlist below would otherwise strip, silently breaking
 *  every tools.call that needs such a credential. Read at call time so a
 *  restart-free override/test applies. */
function passthroughEnvKeys(): string[] {
  return (process.env.ADSCAILE_WORKFLOW_ENV ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export interface AgentCall {
  message?: string;
  data?: unknown;
}

export interface WorkflowResult {
  message?: string;
  state?: unknown;
  agentCalls: AgentCall[];
}

export interface WorkflowRun {
  ok: boolean;
  result?: WorkflowResult;
  error?: string;
  stdout: string;
  stderr: string;
}

const TIMEOUT_MS = (Number(process.env.ADSCAILE_WORKFLOW_TIMEOUT_SECONDS) || 30) * 1000;

function buildWrapper(body: string, prevState: unknown): string {
  const prevLiteral = JSON.stringify(JSON.stringify(prevState ?? null));
  return `import { writeFileSync } from "node:fs";
const __OUT = process.env.ADSCAILE_WORKFLOW_OUT;
const prev = JSON.parse(${prevLiteral});
const __agentCalls = [];
const agent = (message, data) => {
  __agentCalls.push(data === undefined ? { message } : { message, data });
};
// tools.call("server.tool", args) → call one of this machine's configured MCP
// servers (via mcporter). Lazily loads the bridge on first use; a missing bridge
// path or a failed call throws a clear error (propagated as a workflow failure).
const __bridgeUrl = process.env.ADSCAILE_MCP_BRIDGE;
let __bridgeMod;
const tools = {
  call: async (name, args) => {
    if (!__bridgeUrl) throw new Error("tools.call is unavailable: the daemon did not provide an MCP bridge path");
    if (!__bridgeMod) __bridgeMod = await import(__bridgeUrl);
    return __bridgeMod.callTool(name, args);
  },
};
// Bounded best-effort close of the MCP bridge runtime so a lingering MCP
// connection or spawned stdio MCP-server child can't keep this subprocess alive.
// Raced against a hard 2s deadline: a closeRuntime() that never resolves (a stdio
// child that won't exit) still lets the process exit deterministically.
const __closeBridge = async () => {
  if (!__bridgeMod || typeof __bridgeMod.closeRuntime !== "function") return;
  try { await Promise.race([__bridgeMod.closeRuntime(), new Promise((r) => setTimeout(r, 2000))]); } catch {}
};
const __run = async (prev) => {
${body}
};
__run(prev)
  .then(async (out) => {
    const result = typeof out === "string" ? { message: out } : (out ?? {});
    writeFileSync(__OUT, JSON.stringify({ ...result, agentCalls: __agentCalls }));
    await __closeBridge();
    process.exit(0);
  })
  .catch(async (e) => { console.error(e && e.stack ? e.stack : String(e)); await __closeBridge(); process.exit(1); });
`;
}

export async function runWorkflow(body: string, prevState: unknown, cwd: string, signal?: AbortSignal): Promise<WorkflowRun> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adscaile-workflow-"));
  const scriptPath = path.join(dir, "workflow.mjs");
  const outPath = path.join(dir, "out.json");

  await fs.writeFile(scriptPath, buildWrapper(body, prevState), "utf-8");
  try {
    const res = await runProcess(process.execPath, [scriptPath], {
      cwd,
      // Allowlisted env only — the workflow body is server-supplied JS, so it must
      // never inherit the user's full shell (mirrors the claude child's execEnv).
      // The ADSCAILE_WORKFLOW_* prefix carries the tool caps mcp-bridge reads
      // inside the subprocess (ARGS_CAP / RESULT_CAP / TIMEOUT_SECONDS), and
      // ADSCAILE_WORKFLOW_ENV names the exact keys the user passes through for
      // MCP credentials (see passthroughEnvKeys).
      env: {
        ...allowlistEnv({ keys: passthroughEnvKeys(), prefixes: ["ADSCAILE_WORKFLOW_"] }),
        ADSCAILE_WORKFLOW_OUT: outPath,
        ADSCAILE_MCP_BRIDGE: mcpBridgeUrl(),
      },
      signal,
      timeoutMs: TIMEOUT_MS,
    });
    const logs = { stdout: res.stdout, stderr: res.stderr };

    if (res.timedOut) return { ok: false, error: `workflow timed out (>${TIMEOUT_MS / 1000}s)`, ...logs };
    if (res.code !== 0) return { ok: false, error: `workflow exited with code ${res.code}`, ...logs };

    let raw: string;
    try {
      raw = await fs.readFile(outPath, "utf-8");
    } catch {
      return { ok: false, error: "workflow did not write a result", ...logs };
    }
    let parsed: WorkflowResult;
    try {
      parsed = JSON.parse(raw) as WorkflowResult;
    } catch {
      return { ok: false, error: "workflow result is not valid JSON", ...logs };
    }
    if (parsed.message !== undefined && typeof parsed.message !== "string") {
      return { ok: false, error: "workflow `message` must be a string", ...logs };
    }
    return { ok: true, result: parsed, ...logs };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
