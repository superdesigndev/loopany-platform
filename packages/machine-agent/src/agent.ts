/**
 * THE POLL LOOP: one process, both directions.
 *
 * Two cadences on one clock, because they answer different questions:
 *
 *   EFFECTS   claim → execute → report, every `pollMs`. Work orders are latency
 *             sensitive: somebody just clicked Approve and is watching.
 *   SENSING   sweep the watch list every `sensingIntervalMs` (much slower). A PR's
 *             state is not a millisecond concern and every sweep spends shared
 *             GitHub rate-limit budget.
 *
 * They live in ONE process on purpose (captain decision 10): acting and observing are
 * the same trust boundary - the credentials that can comment on a pull request are the
 * credentials that can read a private one - so splitting them into two processes would
 * mean two credential homes and two things to forget to run.
 *
 * ── effects are serial ──────────────────────────────────────────────────────
 *
 * Deliberately. An agent's outward work is small and consequential, and running two
 * merges (or two agent runs) at once buys nothing but a harder failure to read. One at
 * a time also means the heartbeat has an unambiguous subject.
 *
 * ── the heartbeat ───────────────────────────────────────────────────────────
 *
 * A claim carries a lease. While an effect is in flight the agent pushes that lease
 * out on a timer at a third of its length, so a `gh` call - or a ten-minute agent run -
 * slower than the lease does not get its work reclaimed underneath it. If a heartbeat
 * comes back LEASE_LOST the agent says so and lets the attempt finish on its own
 * terms: somebody else owns the row now, and every effect is idempotent (a comment by
 * its marker, a merge by GitHub itself, a run by the check-reality-first discipline the
 * instruction carries).
 *
 * ── nothing is dropped, including this process dying ────────────────────────
 *
 * If the agent crashes mid-effect it reports nothing; the lease expires; the server
 * returns the row to `pending` and, after the attempt budget, FAILS it into the
 * attention list. So "the agent went away" is a visible outcome rather than an effect
 * that quietly never happened - which is the whole reason the lease exists rather than
 * a plain claimed-flag. For a RUN that also means the dispatching task never hangs
 * silently: its `run-started` event is in the log and the failed directive names it.
 */
import type { AgentConfig } from "./config.js";
import { executeDirective, type ExecuteDeps, type RunReporter } from "./execute.js";
import { ghClient, type Gh } from "./gh.js";
import { defaultRunDeps, type RunDeps } from "./run.js";
import { describeSweep, sweepOnce, type SweepResult } from "./sensing.js";
import type {
  ClaimResponse,
  Directive,
  ExecuteOutcome,
  ObservationReportResponse,
  RunOutcome,
  WatchListResponse,
} from "./types.js";

export interface AgentDeps {
  gh: Gh;
  run: RunDeps;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function defaultDeps(): AgentDeps {
  return {
    gh: ghClient(),
    run: defaultRunDeps(),
    fetchImpl: fetch,
    log: (line) => process.stdout.write(`${line}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

export interface PassResult {
  claimed: number;
  done: number;
  failed: number;
}

/** One EFFECTS pass: claim what is due and run it. Returns how many effects landed
 *  and how many refused, so a caller (the loop, a probe, a one-shot run) can say what
 *  the pass did rather than trust it. */
export async function pollOnce(config: AgentConfig, deps: AgentDeps): Promise<PassResult> {
  const claim = await post<ClaimResponse>(config, deps, "effects/claim", {
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
      executeDirective(config, executeDeps(config, deps), directive),
    );
    if (outcome.ok) {
      done++;
      deps.log(`✓ ${directive.kind} ${directive.target.externalId} — ${outcome.result.detail ?? "done"}`);
      await reportDirective(config, deps, { agent: config.agent, id: directive.id, ok: true, result: outcome.result });
    } else {
      failed++;
      deps.log(`✗ ${directive.kind} ${directive.target.externalId} — ${outcome.code}: ${outcome.error}`);
      await reportDirective(config, deps, {
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

/** One SENSING sweep, over the server's watch list. Separate from `pollOnce` so a
 *  one-shot run can do exactly one of each and say what both did. */
export async function sensePeriod(config: AgentConfig, deps: AgentDeps): Promise<SweepResult> {
  const sweep = await sweepOnce(config, {
    gh: deps.gh,
    log: deps.log,
    watchList: () =>
      post<WatchListResponse>(config, deps, "sensing/watchlist", {
        agent: config.agent,
        ...(config.teamId ? { teamId: config.teamId } : {}),
      }),
    report: (input) =>
      post<ObservationReportResponse>(config, deps, "sensing/observations", {
        agent: config.agent,
        ...(config.teamId ? { teamId: config.teamId } : {}),
        observations: input.observations,
        unresolved: input.unresolved,
      }),
  });
  deps.log(describeSweep(sweep));
  for (const r of sweep.refusals) deps.log(`! observation refused — ${r}`);
  for (const u of sweep.unresolved) deps.log(`! unresolved ${u.externalId} — ${u.why}`);
  return sweep;
}

/** The execution seam handed to `executeDirective`: the GitHub client, the sandboxed
 *  runner, and the run-lifecycle reporter that talks to the run entrance. */
function executeDeps(config: AgentConfig, deps: AgentDeps): ExecuteDeps {
  const reporter: RunReporter = {
    started: async (directive) => {
      await post(config, deps, "runs/started", { agent: config.agent, directive: directive.id });
    },
    finished: async (directive, outcome: RunOutcome, detail) => {
      await post(config, deps, "runs/finished", {
        agent: config.agent,
        directive: directive.id,
        outcome,
        ...(detail.summary ? { summary: detail.summary } : {}),
        exitCode: detail.exitCode,
        durationMs: detail.durationMs,
        ...(detail.report ? { report: { body: detail.report } } : {}),
      });
    },
  };
  return { gh: deps.gh, run: deps.run, runReporter: reporter };
}

/** Run the effect with a heartbeat ticking underneath it. The timer is cleared in a
 *  `finally`, so a thrown effect cannot leave one running. */
async function withHeartbeat(
  config: AgentConfig,
  deps: AgentDeps,
  directive: Directive,
  leaseMs: number,
  run: () => Promise<ExecuteOutcome>,
): Promise<ExecuteOutcome> {
  const every = Math.max(2_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void post(config, deps, "effects/heartbeat", { agent: config.agent, id: directive.id }).catch(() => {
      // A lost lease is not an error to crash on: the row is somebody else's now and
      // every effect is idempotent, so the honest response is to say so and let the
      // attempt finish or fail on its own terms.
      deps.log(`· lease on ${directive.id} could not be extended - it may have been reclaimed`);
    });
  }, every);
  timer.unref?.();
  try {
    return await run();
  } catch (err) {
    // An effect that threw is still an outcome, and one the server must hear about -
    // a swallowed exception here is exactly the invisible failure the directive
    // channel exists to prevent.
    return { ok: false, code: "AGENT_ERROR", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(timer);
  }
}

async function reportDirective(config: AgentConfig, deps: AgentDeps, body: Record<string, unknown>): Promise<void> {
  try {
    await post(config, deps, "effects/report", body);
  } catch (err) {
    // The report failed, so the server still believes this directive is claimed. That
    // resolves itself: the lease expires and the row is re-offered, and the effect is
    // idempotent, so the retry is safe. Say so rather than pretending.
    deps.log(`! could not report ${String(body.id)} - the lease will expire and it will be re-offered (${errText(err)})`);
  }
}

async function post<T>(
  config: AgentConfig,
  deps: AgentDeps,
  verb: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await deps.fetchImpl(`${config.serverUrl}/api/agent/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${verb} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/**
 * The loop. Errors NEVER stop it: a server restart, a dropped connection or a 500 are
 * all "try again in a moment", and an agent that exits on the first blip is an agent
 * that is not running when the demo needs it.
 *
 * Sensing rides the same loop on its own schedule rather than a second timer - one
 * clock means a sweep can never overlap an effect pass on the same rate-limit budget,
 * and a sweep that runs long simply delays the next one instead of stacking.
 */
export async function runAgent(
  config: AgentConfig,
  deps: AgentDeps = defaultDeps(),
  options: { signal?: AbortSignal; maxPasses?: number } = {},
): Promise<void> {
  let passes = 0;
  // Sweep on the FIRST pass: a restart should not leave the graph a whole interval
  // stale, which is the same catch-up the in-server poller used to do at boot.
  let nextSweepAt = 0;
  while (!options.signal?.aborted) {
    if (options.maxPasses !== undefined && passes >= options.maxPasses) return;
    passes++;
    try {
      await pollOnce(config, deps);
    } catch (err) {
      deps.log(`! poll failed: ${errText(err)}`);
    }
    if (config.sensing && deps.now() >= nextSweepAt) {
      nextSweepAt = deps.now() + config.sensingIntervalMs;
      try {
        await sensePeriod(config, deps);
      } catch (err) {
        // A failed sweep is never fatal and never needs recovery: re-reporting is
        // free, so the next sweep is the retry.
        deps.log(`! sweep failed: ${errText(err)}`);
      }
    }
    await deps.sleep(config.pollMs);
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
