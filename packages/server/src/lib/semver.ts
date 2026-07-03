/**
 * Tiny semver comparison — just enough to decide "is the daemon older than the
 * latest published version?" for the web's update hint. No dependency; we only
 * need numeric-core ordering (major.minor.patch), and a pre-release is treated
 * as older than its release (a "0.9.0-rc.1" daemon is still behind "0.9.0").
 */

/** Parse the leading numeric core `x.y.z` of a version, ignoring any pre-release
 *  / build suffix. Returns null when it isn't a recognizable version. */
function core(v: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Does `v` carry a pre-release suffix (e.g. "1.2.3-rc.1")? */
function isPre(v: string): boolean {
  return /^\s*v?\d+\.\d+\.\d+-/.test(v);
}

/**
 * `true` when `current` is strictly older than `latest`. Returns `false` on any
 * unparseable/equal/newer input — the hint is opt-in, so we only ever show it
 * when we can be confident the daemon is genuinely behind.
 */
export function isOutdated(current: string | null | undefined, latest: string | null | undefined): boolean {
  if (!current || !latest) return false;
  const a = core(current);
  const b = core(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  // Equal numeric core: a pre-release current is behind a release latest.
  return isPre(current) && !isPre(latest);
}
