/**
 * `@loopany/effect-agent` — the machine side of effect delivery.
 *
 * The server computes and stores; it never acts on the world. This package is
 * what acts: it claims approved outward-effect directives from a Loopany server
 * and executes them with LOCAL credentials. See `README.md` for the wire and the
 * guards, and `cli.ts` for running it.
 */
export { loadConfig, describeConfig, parseRepoAllowlist, type AgentConfig } from "./config.js";
export { checkApproval, checkRepo, checkMergeTarget, findMarkedComment, type Refusal } from "./guards.js";
export { ghClient, runGh, type Gh, type GhRunner, type PrFacts } from "./gh.js";
export { executeDirective } from "./execute.js";
export { runAgent, pollOnce, defaultDeps, type AgentDeps } from "./agent.js";
export type { Directive, ClaimResponse, EffectResult, ExecuteOutcome, RefusalCode } from "./types.js";
