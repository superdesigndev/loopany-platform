/**
 * Machine presence derivation — a single, shared, three-state view of a machine's
 * connectivity used by both the server adapters and the web UI, so the dashboard
 * and loop-detail banner never drift on where the thresholds sit.
 *
 * The daemon heartbeats every poll (~3s), stamping `lastSeen`. A laptop that
 * merely fell ASLEEP (or briefly dropped its network) stops heartbeating but is
 * almost always back on its own within seconds of waking — that is the common,
 * NON-alarming case. We surface it distinctly from a machine that's been gone
 * long enough to actually treat as disconnected:
 *
 *   - `online`  : polled within `MACHINE_ONLINE_TTL_MS` (a live daemon).
 *   - `asleep`  : not online, but seen within `MACHINE_ASLEEP_TTL_MS` (calm — the
 *                 machine is likely asleep/idle and resumes automatically).
 *   - `offline` : never seen, or last seen beyond the asleep window (treat as gone).
 */

/** Mirrors gateway's ONLINE_TTL_MS — a machine is "online" only if it polled recently. */
export const MACHINE_ONLINE_TTL_MS = 30_000;

/**
 * How long after its last heartbeat a machine still reads as merely "asleep"
 * rather than "offline". Six hours comfortably covers an overnight-ish sleep or a
 * lunch-break lid-close without alarming the user; past it, the machine has been
 * gone long enough that "offline" is the honest label.
 */
export const MACHINE_ASLEEP_TTL_MS = 6 * 60 * 60 * 1000;

export type MachinePresence = 'online' | 'asleep' | 'offline';

/**
 * Derive a machine's presence from its stored `online` flag + `lastSeen` stamp.
 * `online` requires BOTH the flag and a fresh stamp (the stored flag lags the
 * sweep by up to one interval); everything else keys off how stale `lastSeen` is.
 */
export function machinePresence(
  online: boolean | null | undefined,
  lastSeen: string | null | undefined,
  now: number = Date.now(),
): MachinePresence {
  const seenAt = lastSeen ? Date.parse(lastSeen) : NaN;
  if (!Number.isFinite(seenAt)) return 'offline'; // never seen
  const age = now - seenAt;
  if (!!online && age < MACHINE_ONLINE_TTL_MS) return 'online';
  if (age < MACHINE_ASLEEP_TTL_MS) return 'asleep';
  return 'offline';
}
