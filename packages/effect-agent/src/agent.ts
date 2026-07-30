/**
 * THE POLL LOOP: claim → execute → report, one work order at a time.
 *
 * Deliberately serial. An effect agent's job is small and consequential, and
 * running two merges at once buys nothing but a harder failure to read. One at a
 * time also means the heartbeat has an unambiguous subject.
 *
 * ── the heartbeat ───────────────────────────────────────────────────────────
 *
 * A claim carries a lease. While an effect is in flight the agent pushes that
 * lease out on a timer at a third of its length, so a `gh` call slower than the
 * lease does not get its work reclaimed underneath it. If a heartbeat comes back
 * LEASE_LOST the agent stops caring about the outcome - somebody else owns the
 * row now, and the effect is idempotent, so the worst case is that the same
 * comment is attempted twice and the marker makes the second a no-op.
 *
 * ── nothing is dropped, including this process dying ────────────────────────
 *
 * If the agent crashes mid-effect it reports nothing; the lease expires; the
 * server returns the row to `pending` and, after the attempt budget, FAILS it
 * into the attention list. So "the agent went away" is a visible outcome rather
 * than an effect that quietly never happened - which is the whole reason the
 * lease exists rather than a plain claimed-flag.
 */
import type { AgentConfig } from "./config.js";
import { executeDirective } from "./execute.js";
import { ghClient, type Gh } from "./gh.js";
import type { ClaimResponse, Directive, ExecuteOutcome } from "./types.js";

export interface AgentDeps {
  gh: Gh;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(): AgentDeps {
  return {
    gh: ghClient(),
    fetchImpl: fetch,
    log: (line) => process.stdout.write(`${line}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** One poll: claim what is due and run it. Returns how many effects landed and
 *  how many refused, so a caller (the loop, a probe, a one-shot run) can say what
 *  the pass did rather than trust it. */
export async function pollOnce(
  config: AgentConfig,
  deps: AgentDeps,
): Promise<{ claimed: number; done: number; failed: number }> {
  const claim = await post<ClaimResponse>(config, deps, "claim", {
    agent: config.agent,
    ...(config.machine ? { machine: config.machine } : {}),
    ...(config.teamId ? { teamId: config.teamId } : {}),
  });
  if (claim.requeued) deps.log(`· ${claim.requeued} abandoned lease(s) returned to the queue`);
  if (claim.expired) deps.log(`! ${claim.expired} directive(s) gave up after repeated lease expiry`);

  let done = 0;
  let failed = 0;
  for (const directive of claim.directives) {
    const outcome = await withHeartbeat(config, deps, directive, claim.leaseMs, () =>
      executeDirective(config, deps.gh, directive),
    );
    if (outcome.ok) {
      done++;
      deps.log(`✓ ${directive.kind} ${directive.target.externalId} — ${outcome.result.detail ?? "done"}`);
      await report(config, deps, { agent: config.agent, id: directive.id, ok: true, result: outcome.result });
    } else {
      failed++;
      deps.log(`✗ ${directive.kind} ${directive.target.externalId} — ${outcome.code}: ${outcome.error}`);
      await report(config, deps, {
        agent: config.agent,
        id: directive.id,
        ok: false,
        refusalCode: outcome.code,
        error: outcome.error,
      });
    }
  }
  return { claimed: claim.directives.length, done, failed };
}

/** Run the effect with a heartbeat ticking underneath it. The timer is cleared in
 *  a `finally`, so a thrown effect cannot leave one running. */
async function withHeartbeat(
  config: AgentConfig,
  deps: AgentDeps,
  directive: Directive,
  leaseMs: number,
  run: () => Promise<ExecuteOutcome>,
): Promise<ExecuteOutcome> {
  const every = Math.max(2_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void post(config, deps, "heartbeat", { agent: config.agent, id: directive.id }).catch(() => {
      // A lost lease is not an error to crash on: the row is somebody else's now
      // and every effect is idempotent, so the honest response is to say so and
      // let the attempt finish or fail on its own terms.
      deps.log(`· lease on ${directive.id} could not be extended - it may have been reclaimed`);
    });
  }, every);
  timer.unref?.();
  try {
    return await run();
  } catch (err) {
    // An effect that threw is still an outcome, and one the server must hear
    // about - a swallowed exception here is exactly the invisible failure the
    // directive channel exists to prevent.
    return { ok: false, code: "AGENT_ERROR", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(timer);
  }
}

async function report(config: AgentConfig, deps: AgentDeps, body: Record<string, unknown>): Promise<void> {
  try {
    await post(config, deps, "report", body);
  } catch (err) {
    // The report failed, so the server still believes this directive is claimed.
    // That resolves itself: the lease expires and the row is re-offered, and the
    // effect is idempotent, so the retry is safe. Say so rather than pretending.
    deps.log(`! could not report ${String(body.id)} - the lease will expire and it will be re-offered (${errText(err)})`);
  }
}

async function post<T>(
  config: AgentConfig,
  deps: AgentDeps,
  verb: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await deps.fetchImpl(`${config.serverUrl}/api/effects/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${verb} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/**
 * The loop. Errors NEVER stop it: a server restart, a dropped connection or a
 * 500 are all "try again in a moment", and an agent that exits on the first blip
 * is an agent that is not running when the demo needs it.
 */
export async function runAgent(
  config: AgentConfig,
  deps: AgentDeps = defaultDeps(),
  options: { signal?: AbortSignal; maxPasses?: number } = {},
): Promise<void> {
  let passes = 0;
  while (!options.signal?.aborted) {
    if (options.maxPasses !== undefined && passes >= options.maxPasses) return;
    passes++;
    try {
      await pollOnce(config, deps);
    } catch (err) {
      deps.log(`! poll failed: ${errText(err)}`);
    }
    await deps.sleep(config.pollMs);
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
