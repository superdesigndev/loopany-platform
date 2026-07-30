/**
 * `@loopany/machine-agent` — the machine side of the graph engine.
 *
 * The server computes and stores; it never touches the outside world and never
 * executes work. This package is what does both, with LOCAL credentials:
 *
 *   SENSING   pulls the watch list, reads GitHub, reports observations back
 *             (captain decision 10 — there is no server-side fetch loop at all)
 *   EFFECTS   claims approved outward-effect work orders and performs them
 *   RUNS      executes approved INSTRUCTIONS in a sandbox and reports the run's
 *             lifecycle back (captain decision 12 — the default path for effects)
 *
 * See `README.md` for the wire and the guards, and `cli.ts` for running it.
 */
export { loadConfig, describeConfig, parseRepoAllowlist, parseArgs, type AgentConfig, type RunConfig } from "./config.js";
export {
  checkApproval,
  checkRepo,
  checkMergeTarget,
  checkRunPermitted,
  findMarkedComment,
  NEVER_EXECUTE,
  type Refusal,
} from "./guards.js";
export {
  ghClient,
  runGh,
  referencedPrs,
  toObserved,
  batchQuery,
  type Gh,
  type GhRunner,
  type PrFacts,
  type PrBatch,
} from "./gh.js";
export {
  composeInstruction,
  resolveWorkdir,
  runInstruction,
  runEnv,
  defaultRunDeps,
  nodeExec,
  INHERITED_ENV,
  type RunDeps,
  type RunOutcomeDetail,
} from "./run.js";
export {
  sweepOnce,
  describeSweep,
  groupByRepo,
  REPO_CONCURRENCY,
  RATE_LIMIT_FLOOR,
  type SweepResult,
} from "./sensing.js";
export { executeDirective, type ExecuteDeps, type RunReporter } from "./execute.js";
export { runAgent, pollOnce, sensePeriod, defaultDeps, type AgentDeps } from "./agent.js";
export {
  instructionOf,
  type Directive,
  type ClaimResponse,
  type EffectResult,
  type ExecuteOutcome,
  type Instruction,
  type ObservedPr,
  type RefusalCode,
  type RunOutcome,
  type WatchItem,
} from "./types.js";
