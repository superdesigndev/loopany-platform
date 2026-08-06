/**
 * MACHINE ENROLLMENT — the one place a device token becomes a `machines` row.
 *
 * Extracted from `MachineGateway.poll` so every device-token surface resolves
 * the credential exactly the way production poll does — two authentication
 * policies would be an audit hole, not a convenience. Poll remains the only
 * surface that may enroll on first contact; owner/kernel/CLI callers use the
 * already-enrolled resolver below.
 *
 * The gate rules it carries, verbatim from the poll path (audit H-01 / M2):
 *   - malformed tokens are filtered by SHAPE before any DB work (cheap filter,
 *     not the auth boundary);
 *   - an already-enrolled machine re-verifies the FULL token hash, so a derived
 *     machine-id collision never hands one machine's authority to another token;
 *   - first contact in OPEN mode enrols anonymously into the shared workspace;
 *   - first contact in GATED mode enrols ONLY a token that resolves to a live
 *     connect key, never a forged one minted into `shared`.
 */
import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { Machine } from "../db/schema.js";
import { loginGateEnabled } from "../lib/loginGate.js";
import { clipText } from "./http.js";
import { getDeviceOwner, isDeviceTokenShape, machineIdFromToken, sha256 } from "./tokens.js";

const log = logger.child({ mod: "enroll" });

/** Presence stamp budget: an idle poll must stay read-only on the hot path. */
export const LAST_SEEN_REFRESH_MS = 10_000;

export interface MachineInfo {
  host?: string;
  platform?: string;
  arch?: string;
  version?: string;
}

export type EnrollResult =
  | { ok: true; machine: Machine; enrolled: boolean }
  | { ok: false; reason: "malformed" | "token-mismatch" | "not-connected" };

/**
 * Authenticate an ALREADY-enrolled machine by the whole device credential.
 *
 * Every device surface uses this resolver. A derived machine id is only an
 * index; the full token hash is the authority. Older rows also retain the
 * plaintext token for the owner-facing reconnect UI. If that exact token still
 * matches but the redundant hash drifted, repair the hash in place and admit
 * the credential. A row with no matching plaintext remains a hard mismatch.
 */
export async function authenticateEnrolledMachine(deviceToken: string): Promise<EnrollResult> {
  if (!isDeviceTokenShape(deviceToken)) return { ok: false, reason: "malformed" };
  const machineId = machineIdFromToken(deviceToken);
  const existing = await store.getMachine(machineId);
  if (!existing) return { ok: false, reason: "not-connected" };
  const expectedHash = sha256(deviceToken);
  if (existing.tokenHash !== expectedHash) {
    if (existing.token !== deviceToken) return { ok: false, reason: "token-mismatch" };
    const repaired = await store.updateMachine(existing.id, { tokenHash: expectedHash });
    if (!repaired) return { ok: false, reason: "not-connected" };
    log.warn({ machineId }, "repaired stale device-token hash from matching enrolled credential");
    return { ok: true, machine: repaired, enrolled: false };
  }
  return { ok: true, machine: existing, enrolled: false };
}

/** Resolve (and on first contact create) the machine behind a device token. */
export async function enrollMachine(deviceToken: string, info?: MachineInfo): Promise<EnrollResult> {
  const enrolled = await authenticateEnrolledMachine(deviceToken);
  if (enrolled.ok || enrolled.reason !== "not-connected") return enrolled;
  const machineId = machineIdFromToken(deviceToken);

  const owner = await getDeviceOwner(machineId);
  if (loginGateEnabled() && owner == null) return { ok: false, reason: "not-connected" };
  const ownerId = owner ?? "shared";
  // Home/default team is ALWAYS the owner's personal team; a loop's real team
  // comes from its validated claim intent, never from this fallback.
  const teamId = store.teamIdForUser(ownerId);
  await store.ensureTeam(teamId, ownerId === "shared" ? "Shared Workspace" : "Personal Team", ownerId === "shared" ? null : ownerId);
  const machine = await store.createMachine({
    id: machineId,
    userId: ownerId,
    teamId,
    // Always name it — `listMachines` hides empty-name rows, so an unnamed
    // self-registered machine would be invisible in the UI and uncounted.
    name: info?.host || `machine-${machineId.slice(2, 8)}`,
    tokenHash: sha256(deviceToken),
    token: deviceToken,
    online: true,
  });
  log.info({ machineId, host: info?.host }, "self-registered machine");
  return { ok: true, machine, enrolled: true };
}

/**
 * Stamp presence + identity for a machine that just spoke. Throttled: an idle
 * poll only writes when the flag must flip or the stamp aged past
 * `LAST_SEEN_REFRESH_MS`, and identity fields are written only when one differs.
 */
export async function stampMachineContact(machine: Machine, info?: MachineInfo): Promise<void> {
  if (!machine.online || !machine.lastSeen || Date.now() - Date.parse(machine.lastSeen) > LAST_SEEN_REFRESH_MS) {
    await store.setMachineOnline(machine.id, true);
  }
  if (!info) return;
  // Untrusted wire input: a version is a short semver, so clip defensively.
  const version = typeof info.version === "string" ? clipText(info.version, 64) : undefined;
  const patch = {
    ...(info.host && info.host !== machine.hostname ? { hostname: info.host } : {}),
    ...(info.platform && info.platform !== machine.platform ? { platform: info.platform } : {}),
    ...(info.arch && info.arch !== machine.arch ? { arch: info.arch } : {}),
    ...(version && version !== machine.daemonVersion ? { daemonVersion: version } : {}),
    ...(info.host && !machine.name?.trim() ? { name: info.host } : {}),
  };
  if (Object.keys(patch).length) await store.updateMachine(machine.id, patch);
}
