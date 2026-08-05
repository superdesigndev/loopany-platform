/**
 * Which stack is this server, when it is NOT production.
 *
 * A developer runs three stacks on one machine (local dev, the deployed testing
 * app, production) while every run prompt says plainly `loopany`. The exec run's
 * banner line names the serving host when the target is a developer one, so a
 * transcript can never be read against the wrong stack.
 *
 * SILENCE IS THE DEFAULT, by construction: only a loopback host (DEV) and the
 * `loopany-testing` deploy (TESTING) are recognized, and every other target -
 * production, any self-hosted domain - classifies as null. Production prompt
 * bytes are therefore byte-identical to what they were before this existed
 * (pinned by `gateway/prompt.test.ts`).
 *
 * The input is `LOOPANY_BASE_URL`, the server's own public base URL (the same
 * value Better Auth uses, `auth.ts`), with the same `http://127.0.0.1:3000`
 * default - an unset value genuinely means a local dev server.
 *
 * The twin of this classifier lives at `packages/daemon/src/env-banner.ts` (the
 * CLI's stderr banner). Two tiny pure copies, one per package, because the daemon
 * ships as its own npm tarball and shares no module with the server; keep the two
 * rule sets identical when either changes.
 */

/** A recognized NON-production target: the short label plus its host[:port]. */
export interface EnvTarget {
  label: "DEV" | "TESTING";
  host: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"]);

/** Classify a base URL. Null for production and every unrecognized value. */
export function classifyEnvTarget(baseUrl: string | undefined): EnvTarget | null {
  const raw = (baseUrl ?? "").trim();
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

/**
 * This server's own base URL - `LOOPANY_BASE_URL`, exactly as `auth.ts` reads it.
 * Unset means a local dev server, so the fallback names the port this process is
 * actually listening on (`LOOPANY_PORT`, the isolated-stack recipe's variable),
 * defaulting to 3000 like `auth.ts`. A deployed stack always sets
 * `LOOPANY_BASE_URL`, so the fallback never applies there.
 */
export function serverBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOOPANY_BASE_URL) return env.LOOPANY_BASE_URL;
  return `http://127.0.0.1:${env.LOOPANY_PORT?.trim() || "3000"}`;
}

/**
 * The run-prompt banner suffix: ` · via <host>` on a developer stack, and the
 * EMPTY string on production, so a production prompt is unchanged.
 */
export function viaHostSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const target = classifyEnvTarget(serverBaseUrl(env));
  return target ? ` · via ${target.host}` : "";
}
