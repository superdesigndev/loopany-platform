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
 * Every external touch (fetch, cwd, homedir, pid, server, output) is an injectable
 * seam so tests need no real process/network/~.loopany.
 */
import os from "node:os";

import { existingBinShim } from "./bin-shim.js";
import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli, printText } from "./cli-client.js";
import { resolveServerUrl } from "./config.js";
import { verifiedRunningPid } from "./pidfile.js";

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
  const bin = (injected.binPath ?? (() => existingBinShim()))();
  const serverDisplay = (injected.serverDisplay ?? (() => resolveServerUrl(undefined)))();

  // Context the SERVER can't know — the render is still entirely server-side, we just
  // feed it the local facts. Omit an absent fact rather than send an empty flag.
  const ctx: string[] = ["--cwd", cwd, "--home", homedir];
  if (bin) ctx.push("--bin", bin);
  if (pid !== undefined) ctx.push("--pid", String(pid));
  if (serverDisplay) ctx.push("--server", serverDisplay);

  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchImpl,
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
    out(notConnectedHome());
    return 0;
  }
  if (r.kind === "read-error") return out(`error: "cannot read ${r.path}"\ncode: ERROR\n`), 1;
  if (r.kind === "network-error") return out(`error: ${JSON.stringify(r.message)}\ncode: ERROR\n`), 1;

  // Text-sink primary: print the server's rendered TOON home.
  const code = printText(r.body, r.status, out);
  if (code !== null) return code;

  // Old server, no `text` — render a minimal home from the loops list (one release).
  const loops = (r.body as { loops?: LoopRow[] }).loops ?? [];
  out(fallbackHome(loops, serverDisplay));
  return 0;
}

/** The definitive not-connected home rendered locally (no server round-trip possible
 *  — there is no credential/server). Mirrors the server's not-connected shape. */
function notConnectedHome(): string {
  return (
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.\n" +
    "machine: not connected — run `loopany up`\n" +
    "help[2]:\n" +
    "  Run `loopany up --server-url <url> --connect-key <dk_…>` to connect this machine\n" +
    "  Run `loopany --help` to see every command\n"
  );
}

/** Minimal home from an OLD server's loops list (no `home` verb). Never empty. */
function fallbackHome(loops: LoopRow[], server: string): string {
  const lines = [
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
