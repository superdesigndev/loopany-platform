/**
 * MCP bridge for the workflow sandbox — the JS API behind `tools.call(name, args)`.
 *
 * A loop's deterministic workflow runs in a bare `node` subprocess (see
 * workflow.ts). This module is what that subprocess imports to reach the machine's
 * OWN configured MCP servers (via mcporter), so the repetitive mechanical half of a
 * loop — fetch / list / dedup / filter / sort against an external tool the agent used
 * to re-invoke every run — becomes cheap deterministic code, leaving only the genuine
 * judgment/summary/decision for the LLM agent.
 *
 * Authored as PLAIN ESM (`.mjs`, no TypeScript) on purpose: the workflow subprocess is
 * spawned with a bare `node` (never tsx), so it must import a file bare node can run in
 * BOTH dev (from `src/`) and prod (from `dist/`, copied by scripts/copy-runtime-assets.mjs).
 * `import("mcporter")` resolves relative to THIS file's location → the daemon package's
 * node_modules in either tree.
 *
 * Contract (phase 1):
 *   - `callTool("server.tool", args)` → the tool's result, shaped as `{ text, data }`
 *     (see shapeResult). `name` is `"server.tool"` form (server before the first dot).
 *   - Reads the machine's OWN mcporter-configured servers; runs fully headless
 *     (`disableOAuth: true` — cached bearer tokens are used, no interactive OAuth is
 *     ever launched, so an unattended workflow never blocks on a browser prompt).
 *   - Caps: args JSON is capped before send; the returned text/data is capped. Both
 *     overridable by env (ADSCAILE_WORKFLOW_TOOL_ARGS_CAP / _RESULT_CAP / _TIMEOUT_SECONDS).
 *   - Clear errors: a missing server, missing/failed tool, missing auth, or unavailable
 *     runtime THROWS a specific error naming the server/tool and what's missing. No
 *     silent success, no vague failure. (A thrown error propagates out of the workflow,
 *     which the runner turns into an agent fallback — see runner.ts.)
 *   - Read-like only (phase 1) is a PROMPT posture (create.md / evolve.md), not enforced
 *     here — the guardrail is authoring guidance, not a code blocklist.
 */

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Max bytes of JSON-serialized args sent to a tool (default 16KB). */
export const argsCap = () => num("ADSCAILE_WORKFLOW_TOOL_ARGS_CAP", 16 * 1024);
/** Max chars of tool result text/data returned into the sandbox (default 256KB). */
export const resultCap = () => num("ADSCAILE_WORKFLOW_TOOL_RESULT_CAP", 256 * 1024);
/** Per-call wall-clock timeout in ms (default 30s, mirrors the workflow timeout). */
export const callTimeoutMs = () => num("ADSCAILE_WORKFLOW_TOOL_TIMEOUT_SECONDS", 30) * 1000;

/** Split "server.tool" on the FIRST dot (a tool name may itself contain dots). */
export function parseToolName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`tools.call: tool name must be a non-empty string of the form "server.tool"`);
  }
  const i = name.indexOf(".");
  if (i <= 0 || i === name.length - 1) {
    throw new Error(`tools.call: name "${name}" must be "server.tool" (server before the first dot, e.g. "posthog.projects-get")`);
  }
  return { server: name.slice(0, i), tool: name.slice(i + 1) };
}

/** Validate + measure args; throw if oversized (a runaway payload never leaves the box). */
export function capArgs(server, tool, args) {
  const value = args ?? {};
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    throw new Error(`tools.call: "${server}.${tool}" args are not JSON-serializable: ${e?.message || e}`);
  }
  const cap = argsCap();
  if (json.length > cap) {
    throw new Error(`tools.call: "${server}.${tool}" args too large (${json.length} bytes > ${cap} cap — raise ADSCAILE_WORKFLOW_TOOL_ARGS_CAP)`);
  }
  return value;
}

/** Flatten an MCP result's `content` array to text (text parts joined; others JSON'd). */
export function extractText(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.content)) {
    return raw.content
      .map((c) => {
        if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") return c.text;
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      })
      .join("\n");
  }
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function clip(s, cap) {
  if (typeof s !== "string" || s.length <= cap) return { text: s, truncated: false };
  return { text: s.slice(0, cap) + `\n… (truncated — result exceeded ${cap} chars; raise ADSCAILE_WORKFLOW_TOOL_RESULT_CAP)`, truncated: true };
}

/**
 * Shape a raw MCP result into `{ text, data, truncated? }` for the workflow author:
 *   - `text`: the tool's textual output, capped to resultCap().
 *   - `data`: the tool's structured content (or JSON parsed from the text when the text
 *     is a JSON document), else `null`. Dropped to `null` if it alone exceeds resultCap()
 *     (the capped text still carries the payload) so a runaway result can't blow up the report.
 */
export function shapeResult(raw) {
  const cap = resultCap();
  const clipped = clip(extractText(raw), cap);
  let data = null;
  const structured =
    raw && typeof raw === "object" && "structuredContent" in raw ? raw.structuredContent : undefined;
  if (structured !== undefined && structured !== null) {
    data = structured;
  } else if (!clipped.truncated) {
    const t = (clipped.text || "").trim();
    if (t && (t[0] === "{" || t[0] === "[")) {
      try {
        data = JSON.parse(t);
      } catch {
        data = null;
      }
    }
  }
  let dataDropped = false;
  if (data !== null) {
    let dj;
    try {
      dj = JSON.stringify(data);
    } catch {
      dj = "";
    }
    if (!dj || dj.length > cap) {
      data = null; // don't let structured data blow the cap
      dataDropped = true;
    }
  }
  const out = { text: clipped.text, data };
  if (clipped.truncated || dataDropped) out.truncated = true;
  return out;
}

/** Turn an mcporter connection/call error into a specific, actionable message. */
export function classifyCallError(server, tool, message) {
  const m = String(message || "");
  if (/Unknown MCP server/i.test(m)) {
    return `MCP server "${server}" is not configured on this machine (run \`mcporter list\` to see configured servers)`;
  }
  if (/\b401\b|unauthor|forbidden|\b403\b/i.test(m)) {
    return `authentication required or expired for MCP server "${server}" — re-authorize it (this workflow can never do interactive auth): ${m}`;
  }
  if (/timed? ?out|timeout/i.test(m)) {
    return `MCP server "${server}" timed out calling "${tool}": ${m}`;
  }
  return `MCP call "${server}.${tool}" failed: ${m}`;
}

let _runtimePromise = null;

/** Lazily create (and cache) the mcporter runtime. Only imports mcporter on real use. */
async function getRuntime(makeRuntime) {
  if (makeRuntime) return makeRuntime();
  if (!_runtimePromise) {
    _runtimePromise = (async () => {
      let mod;
      try {
        mod = await import("mcporter");
      } catch (e) {
        throw new Error(`tools.call: MCP runtime (mcporter) could not be loaded — is it installed with the daemon? ${e?.message || e}`);
      }
      return mod.createRuntime();
    })();
  }
  return _runtimePromise;
}

/**
 * Best-effort dispose of the cached mcporter runtime and reset the cache. A no-op when no
 * runtime was ever created; never throws — an open MCP connection or a spawned stdio
 * MCP-server child must not keep the workflow subprocess alive past its result write.
 */
export async function closeRuntime() {
  const pending = _runtimePromise;
  _runtimePromise = null;
  if (!pending) return;
  try {
    const rt = await pending;
    if (rt && typeof rt.close === "function") await rt.close();
  } catch {}
}

/**
 * Call an MCP tool. `opts.makeRuntime` is a test seam (inject a fake runtime); `opts.timeoutMs`
 * overrides the per-call timeout. Throws a clear, specific error on every failure mode.
 */
export async function callTool(name, args, opts = {}) {
  const { server, tool } = parseToolName(name);
  const safeArgs = capArgs(server, tool, args);

  let rt;
  try {
    rt = await getRuntime(opts.makeRuntime);
  } catch (e) {
    throw e instanceof Error ? e : new Error(`tools.call: MCP runtime unavailable: ${e}`);
  }

  let raw;
  try {
    raw = await rt.callTool(server, tool, {
      args: safeArgs,
      disableOAuth: true,
      timeoutMs: opts.timeoutMs ?? callTimeoutMs(),
    });
  } catch (e) {
    throw new Error(`tools.call: ${classifyCallError(server, tool, e?.message || e)}`);
  }

  // mcporter surfaces tool-level failures (missing tool, tool errors) as a result with
  // isError:true rather than throwing — turn that into a clear thrown error ourselves.
  if (raw && typeof raw === "object" && raw.isError) {
    const detail = extractText(raw).trim().slice(0, 800) || "(no detail)";
    throw new Error(`tools.call: MCP tool "${server}.${tool}" returned an error — ${detail}`);
  }

  return shapeResult(raw);
}
