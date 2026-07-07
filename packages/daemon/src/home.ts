/**
 * Bare `loopany` OUT of a run — the content-first HOME view (P8/§5.1). The daemon is
 * a text sink: it collects the local facts only IT knows (cwd + home dir for the
 * directory scoping, the PATH shim path, the daemon pid, the server URL) and posts
 * them as `home` context flags to the unified `/api/machine/cli`; the SERVER owns the
 * whole TOON render (`renderHomeText`). The daemon just prints `body.text`.
 *
 * Never empty (P5/P8): when this machine has no stored credential/server the post
 * short-circuits to a DEFINITIVE local "not connected — run `loopany up`" view; on an
 * OLD server (no `home` verb → the legacy loops fallback) a minimal home is rendered
 * from the structured loop list. The in-run bare `loopany` is handled separately
 * (cli.ts routes it to the callback as `home` on the run credential).
 *
 * Bounded on the hot path (feedback follow-up): batch 6 runs this home view on EVERY
 * SessionStart via the installed hook, so the network round-trip must degrade fast. The
 * home POST goes through `boundedFetch` (a few-second timeout + AbortSignal), so an
 * unreachable-but-not-refused server (a hung TCP connection) fails fast to a DEFINITIVE
 * degraded home (`server unreachable`) instead of stalling session start until the OS
 * timeout. Interactive verbs keep their own fetch budgets.
 *
 * Every external touch (fetch, cwd, homedir, pid, server, output) is an injectable
 * seam so tests need no real process/network/~.loopany.
 */
import os from "node:os";

import { resolveDurableBinPath } from "./bin-shim.js";
import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli, printText } from "./cli-client.js";
import { resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import { verifiedRunningPid } from "./pidfile.js";

/** The SessionStart hot path budget: fail fast to a degraded home rather than stall a
 *  session on a hung server. */
const HOME_TIMEOUT_MS = 4_000;

/** `fetch` bounded to `HOME_TIMEOUT_MS` — the default home transport (tests inject
 *  their own `fetchImpl`). */
const boundedHomeFetch = ((url: string, init?: RequestInit) =>
  boundedFetch(String(url), init ?? {}, HOME_TIMEOUT_MS)) as unknown as typeof fetch;

export interface HomeDeps {
  fetchImpl?: typeof fetch;
  server?: string;
  token?: string;
  cwd?: () => string;
  homedir?: () => string;
  localPid?: () => number | undefined;
  binPath?: () => string | null;
  serverDisplay?: () => string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

interface LoopRow {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
}

export async function runHome(injected: HomeDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const cwd = (injected.cwd ?? (() => process.cwd()))();
  const homedir = (injected.homedir ?? os.homedir)();
  const pid = (injected.localPid ?? (() => verifiedRunningPid()))();
  // The durable `loopany` path (our shim OR a real global on PATH) for the home's
  // `bin:` line (P8). Null ⇒ npx-without-global; the SERVER then renders the honest
  // "not on PATH — npm i -g" fallback so the line ALWAYS leads the home (F7).
  const bin = (injected.binPath ?? (() => resolveDurableBinPath()))();
  const serverDisplay = (injected.serverDisplay ?? (() => resolveServerUrl(undefined)))();

  // Context the SERVER can't know — the render is still entirely server-side, we just
  // feed it the local facts. Omit an absent fact rather than send an empty flag.
  const ctx: string[] = ["--cwd", cwd, "--home", homedir];
  if (bin) ctx.push("--bin", bin);
  if (pid !== undefined) ctx.push("--pid", String(pid));
  if (serverDisplay) ctx.push("--server", serverDisplay);

  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchImpl ?? boundedHomeFetch,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  // Old-server (no /api/machine/cli) fallback: the loops list, so a minimal home can
  // still be rendered from the structured rows.
  const legacy: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const res = await fetchImpl(`${server}/api/machine/loop`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const r = await postCli(["home", ...ctx], legacy, cliDeps);
  // Not connected: no credential/server on this machine yet — render the DEFINITIVE
  // local state (never empty output), telling the owner exactly how to connect.
  if (r.kind === "not-configured") {
    out(notConnectedHome(bin));
    return 0;
  }
  if (r.kind === "read-error") return out(`error: "cannot read ${r.path}"\ncode: ERROR\n`), 1;
  // Unreachable / hung server (incl. a bounded-fetch timeout on the SessionStart hot
  // path): render a DEFINITIVE degraded home — never hang, never empty, never a raw
  // error line that would surface the ambient hook as a failure.
  if (r.kind === "network-error") {
    out(degradedHome(bin, serverDisplay, r.message));
    return 0;
  }

  // Text-sink primary: print the server's rendered TOON home.
  const code = printText(r.body, r.status, out);
  if (code !== null) return code;

  // Old server, no `text` — render a minimal home from the loops list (one release).
  const loops = (r.body as { loops?: LoopRow[] }).loops ?? [];
  out(fallbackHome(bin, loops, serverDisplay));
  return 0;
}

/** The `bin:` line that leads EVERY home view (P8): the real durable path when known,
 *  else the honest "not on PATH" fallback with the fix. Mirrors the server's
 *  `renderHomeText` so the local and server-rendered homes agree. */
export function binLine(bin: string | null): string {
  return bin ? `bin: ${bin}` : "bin: (not on PATH — run `npm i -g @crewlet/loopany`)";
}

/** The definitive not-connected home rendered locally (no server round-trip possible
 *  — there is no credential/server). Mirrors the server's not-connected shape. */
function notConnectedHome(bin: string | null): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.\n" +
    "machine: not connected — run `loopany up`\n" +
    "help[2]:\n" +
    "  Run `loopany up --server-url <url> --connect-key <dk_…>` to connect this machine\n" +
    "  Run `loopany --help` to see every command\n"
  );
}

/** The definitive DEGRADED home when the server is unreachable or hung (the machine IS
 *  configured, so this isn't the not-connected view). Never empty; exits 0 so the
 *  SessionStart hook never surfaces as a failure. */
function degradedHome(bin: string | null, server: string, reason: string): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.\n" +
    `machine: configured${server ? ` · ${server}` : ""} — server unreachable right now (${reason})\n` +
    "help[1]:\n" +
    "  Run `loopany loops` once the server is reachable to list this machine's loops\n"
  );
}

/** Minimal home from an OLD server's loops list (no `home` verb). Never empty. */
function fallbackHome(bin: string | null, loops: LoopRow[], server: string): string {
  const lines = [
    binLine(bin),
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.",
    `machine: connected${server ? ` · ${server}` : ""}`,
  ];
  if (loops.length) {
    lines.push(`loops[${loops.length}]{id,name,cron,enabled}:`);
    for (const l of loops) lines.push(`  ${l.id},${l.name},${l.cron},${l.enabled ? "on" : "paused"}`);
  } else {
    lines.push("loops: []");
  }
  lines.push("help[1]:", "  Run `loopany loops` to list every loop on this machine");
  return lines.join("\n") + "\n";
}
