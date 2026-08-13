/**
 * Machine-local config under ~/.loopany — the device token (machine identity)
 * and the server URL. The daemon persists both when it connects; the interactive
 * `loopany loops` / `loopany edit` commands read them back so editing a loop from
 * the owner's Claude Code is zero-config (no re-auth, no flags).
 *
 * Set LOOPANY_HOME to relocate this dir — run a dev daemon against localhost with
 * `LOOPANY_HOME=~/.loopany-dev` so its identity/server don't clobber the prod
 * `~/.loopany` you keep connected to the live server (and vice-versa).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOOPANY_DIR = process.env.LOOPANY_HOME || path.join(os.homedir(), ".loopany");
export const DEVICE_FILE = path.join(LOOPANY_DIR, "device-token");
export const MACHINE_FILE = path.join(LOOPANY_DIR, "machine.json");
export const MACHINE_TERMINAL_FILE = path.join(LOOPANY_DIR, "machine-terminal.json");
export const SERVER_FILE = path.join(LOOPANY_DIR, "server-url");

/** Best-effort 0600 persistence (so a stable identity survives restarts). */
export function persist(file: string, value: string): void {
  try {
    fs.mkdirSync(LOOPANY_DIR, { recursive: true });
    fs.writeFileSync(file, value, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function readStored(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export type MachineState = { kind: "loopany-machine"; schemaVersion: 1; id: string; key: string; enrolledBy?: string };
export function readMachineState(): MachineState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(MACHINE_FILE, "utf8")) as MachineState;
    return value.kind === "loopany-machine" && value.schemaVersion === 1 && value.id && value.key.startsWith("mk_") ? value : undefined;
  } catch { return undefined; }
}
export function persistMachineState(value: MachineState): void { persist(MACHINE_FILE, JSON.stringify(value, null, 2)); try { fs.rmSync(MACHINE_TERMINAL_FILE, { force: true }); } catch {} }
export function machineHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  const machine = readMachineState();
  return { Authorization: `Bearer ${token}`, ...(machine?.key === token ? { "X-Loopany-Machine-Id": machine.id } : {}), ...extra };
}

/** Read a `--flag value` from an argv slice (bare/terminal `--flag` → ""). */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}

/** Resolve this machine's server URL: explicit flag → env → stored, with any
 *  trailing slash stripped (so `${server}/api/...` never doubles up). */
export function resolveServerUrl(flagValue: string | undefined): string {
  return (flagValue || process.env.LOOPANY_SERVER_URL || readStored(SERVER_FILE) || "").replace(/\/$/, "");
}
