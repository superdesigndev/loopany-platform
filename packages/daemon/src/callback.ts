/**
 * Callback mode — `loopany <verb> [...flags]` invoked by claude (via the PATH
 * wrapper) inside a run. Delegates to the shared CLI client (`postCli`): it picks the
 * run token from the env, inlines the file flags, and POSTs `{argv}` to the unified
 * `/api/machine/cli`, falling back to the legacy `/agent-api/loop` on a 404 (old
 * server). This module just renders the `{text, exitCode}` reply for the agent.
 */
import { legacyRun, postCli, printTextOrTooOld } from "./cli-client.js";

export async function runCallback(argv: string[]): Promise<number> {
  const r = await postCli(argv, legacyRun);
  if (r.kind === "not-configured") {
    process.stderr.write("loopany: control channel not configured\n");
    return 2;
  }
  if (r.kind === "read-error") {
    process.stderr.write(`loopany: cannot read ${r.path}\n`);
    return 1;
  }
  if (r.kind === "network-error") {
    process.stderr.write(`loopany: ${r.message}\n`);
    return 1;
  }
  // Text-sink: print the server's rendered `text` + exit its `exitCode`. A too-old
  // server (no `text`) surfaces a definitive SERVER_TOO_OLD error, never blank output.
  return printTextOrTooOld(r.body, r.status, (s) => process.stdout.write(s));
}
