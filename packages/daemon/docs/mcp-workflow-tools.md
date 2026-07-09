# MCP tool calls inside loop workflows (phase 1)

A loop's deterministic JS workflow can call the MCP servers **already configured on the
machine** via `tools.call("server.tool", args)`. This folds the mechanical
"fetch / list / dedup / filter / sort" half of a loop — the tool call the coding agent
used to re-invoke every run — into cheap deterministic code, leaving only genuine
judgment / summary / decision for the LLM agent.

## Surface (what a workflow author writes)

The workflow body is the **whole surface** — a plain statement sequence run inside an
async function, ending in `return { message?, state? }`. There is **no `export const
meta` header and no top-level `import`**: the body is NOT an ES module and NOT the
Claude Code `Workflow` tool. The example below is complete as written.

```js
// Inside a loop's workflow body (see references/evolve.md §2b for the full contract):
const res = await tools.call("posthog.query-run", { query: { kind: "HogQLQuery", query: "..." } });
// res = { text: string, data: <structured | null>, truncated?: true }
const rows = res.data?.results ?? [];
return { message: `${rows.length} rows`, state: { cursor: res.data?.last } };
// or hand prepared data to the agent for the judgment part:
agent("write the digest from these rows", res.data);
```

- `name` is `"server.tool"` (server = before the first dot).
- Returns `{ text, data }`: `text` is the tool's textual output (capped); `data` is its
  structured content, or JSON parsed from `text` when the text is JSON, else `null`.
- **Read-like only** in phase 1 (fetch/list/query/get). Do not lift write/high-risk tools.
- **Runs headless** — no interactive OAuth is ever launched. Cached credentials only.
- **Allowlisted env** — the workflow subprocess never inherits the user's full shell. An
  MCP server config that resolves a credential from the environment (`${VAR}` / `$env:VAR`
  placeholders, or a stdio server's env) needs that key opted in via
  `ADSCAILE_WORKFLOW_ENV=KEY1,KEY2` in the daemon's environment, or the call throws
  `Environment variable X is required`.
- **Throws a clear error** on a missing/unconfigured server, missing/failed tool, missing
  or expired auth, or an unavailable MCP runtime — naming the server/tool and what's missing.
- A workflow failure (including a failed `tools.call`) **falls back to the agent**: the run
  still completes its original task, then the agent diagnoses the failure and — if fixing
  needs the user to authorize a server / set a credential — writes a dated
  `workflow-setup-<date>.md` in the loop's workdir with a one-line copy-paste fix prompt.

## Caps (env overridable)

| Env var                                   | Default | Meaning                              |
| ----------------------------------------- | ------- | ------------------------------------ |
| `ADSCAILE_WORKFLOW_TOOL_ARGS_CAP`          | 16384   | max bytes of JSON args sent to a tool |
| `ADSCAILE_WORKFLOW_TOOL_RESULT_CAP`        | 262144  | max chars of result text/data returned |
| `ADSCAILE_WORKFLOW_TOOL_TIMEOUT_SECONDS`   | 30      | per-call wall-clock timeout           |
| `ADSCAILE_WORKFLOW_ENV`                    | (empty) | comma-separated env keys passed through to the workflow subprocess (MCP credentials) |

## How it's wired (implementation)

- `src/mcp-bridge.mjs` — plain ESM (bare-node-importable in dev `src/` AND prod `dist/`,
  copied by `scripts/copy-runtime-assets.mjs`). Backs `tools.call` with
  [`mcporter`](https://www.npmjs.com/package/mcporter)'s JS API
  (`createRuntime().callTool(server, tool, { args, disableOAuth: true, timeoutMs })`).
  `disableOAuth: true` is the headless flag — cached bearer tokens are used, no browser
  prompt. mcporter surfaces tool-level failures as `{ isError: true }`; the bridge turns
  that (and connection/auth throws) into clear thrown errors.
- `src/workflow.ts` injects `tools.call` into the workflow subprocess and passes the bridge
  file URL via `ADSCAILE_MCP_BRIDGE` (overridable — tests point it at a fixture bridge).
- `src/runner.ts` — on any workflow failure, builds the fallback task via
  `buildWorkflowFallbackTask()` and runs the agent instead of reporting a failed run.

## Local manual acceptance — real PostHog MCP server

This proves end to end that a workflow `tools.call` against a **real** configured MCP
server returns prepared data. It requires a PostHog MCP server configured + authorized on
the running machine (this repo's owner has one). No secret is ever committed — mcporter
reads the machine's own configured servers and cached auth at runtime.

**Prerequisite:** a PostHog MCP server configured for mcporter (or a compatible client
mcporter reads) with a valid cached token. Verify with:

```bash
cd packages/daemon
node --input-type=module -e 'const {createRuntime}=await import("mcporter"); const rt=await createRuntime(); console.log(rt.listServers());'
# → should include "posthog"
```

**Run the acceptance workflow** (uses the BUILT bridge in `dist/`, exactly the runtime path
a live loop uses):

```bash
cd packages/daemon
pnpm build   # ensures dist/mcp-bridge.mjs + dist/workflow.js exist

node --input-type=module -e '
import { runWorkflow } from "./dist/workflow.js";
const body = `
  const res = await tools.call("posthog.projects-get", {});
  const names = res.text.split("\n").filter(l => l.trim().startsWith("name:")).map(l => l.trim());
  return { message: "found " + names.length + " projects: " + names.join(" | "),
           state: { projects: names.length, textLen: res.text.length } };
`;
const r = await runWorkflow(body, null, process.cwd());
console.log("ok:", r.ok, "| message:", r.result?.message, "| state:", JSON.stringify(r.result?.state));
if (!r.ok) console.log("error:", r.error, "\n", r.stderr.slice(-800));
'
```

**Expected:** `ok: true` and a message listing your PostHog project names, e.g.
`found 2 projects: name: Crewlet | name: Superdesign`. This is the deterministic
"prepared data" a workflow hands off — the loop would then either report it directly or
pass it to `agent(message, data)` for the judgment.

**Failure modes to confirm the guardrails** (optional):
- Wrong tool name → the run fails with `MCP tool "posthog.nope" returned an error — Tool nope not found`.
- No/expired auth → fails fast with an `authentication required or expired … re-authorize` error
  (never hangs on a prompt). In a real loop this falls back to the agent, which writes the
  `workflow-setup-<date>.md` setup file.

### Automated coverage (no live server needed)

`pnpm --filter @crewlet/adscaile test` covers the same wiring with fixtures/fakes:
`mcp-bridge.test.ts` (caps, result shaping, clear errors for missing server/tool/auth/runtime),
`workflow.test.ts` (`tools.call` injected into the sandbox; args in / result out; failure surfaces),
`runner.test.ts` (workflow-failure → agent-fallback carrying the original task + workflow error +
source + dated setup file + fix prompt).
