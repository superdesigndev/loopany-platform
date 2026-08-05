/**
 * The DEV-ONLY environment banner.
 *
 * A developer can have three Loopany stacks on one machine - a local dev server,
 * the deployed testing stack, and production - while every prompt, doc and habit
 * says plainly `loopany`. One line on stderr naming the resolved target removes
 * the ambiguity for the one person who has it.
 *
 * SILENCE IS THE DEFAULT, by construction. Only two targets are recognized as
 * non-production - a loopback host (DEV) and the `loopany-testing` deploy
 * (TESTING) - and everything else, production included, prints NOTHING. An
 * ordinary user has exactly one environment and never sees this code breathe, so
 * there is no setting to discover and nothing to turn off.
 *
 * It writes to STDERR so it can never corrupt a consumer: every machine-readable
 * path in this CLI (`--json`, `log --transcript`, the SessionStart hook's ambient
 * context, the `home` view) is STDOUT, and the daemon is a pure stdout text sink.
 *
 * The twin of this classifier lives at `packages/server/src/lib/envTarget.ts`
 * (the run prompt's `via <host>` suffix). Two tiny pure copies, one per package,
 * because the daemon ships as its own npm tarball and shares no module with the
 * server; keep the two rule sets identical when either changes.
 */

/** A recognized NON-production target: the short label plus its host[:port]. */
export interface EnvTarget {
  label: "DEV" | "TESTING";
  host: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"]);

/**
 * Classify a resolved server URL. Returns null for production, for an
 * unconfigured/unparseable value, and for any host this does not recognize as a
 * developer target - the silent default.
 */
export function classifyEnvTarget(serverUrl: string | undefined): EnvTarget | null {
  const raw = (serverUrl ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK.has(hostname) || hostname.endsWith(".local")) return { label: "DEV", host: url.host };
  if (hostname.includes("loopany-testing")) return { label: "TESTING", host: url.host };
  return null;
}

/** The banner line (with its newline), or null when the target is silent. */
export function envBannerLine(serverUrl: string | undefined): string | null {
  const target = classifyEnvTarget(serverUrl);
  return target ? `» loopany · ${target.label} · ${target.host}\n` : null;
}

/** Print the banner to stderr. A no-op on a production/unrecognized target. */
export function printEnvBanner(serverUrl: string | undefined, write: (s: string) => void = (s) => void process.stderr.write(s)): void {
  const line = envBannerLine(serverUrl);
  if (line) write(line);
}
