/**
 * @loopany/simulator - a version-independent kernel scenario runner.
 *
 * A scenario (pure data) is driven against a sandbox workspace on a virtual
 * clock; per-day snapshots feed the scoring rubric. See the design doc
 * docs/plans/2026-08-10-simulator-scenario-superdesign.md.
 */
export { runScenario, type RunOpts } from "./engine.js";
export {
  createSandbox,
  buildEnv,
  kernelBinPath,
  packagedShimsDir,
  fixturesDir,
  plantRepo,
  type Sandbox,
  type SandboxOpts,
} from "./sandbox.js";
export {
  seedClaudeIdentity,
  realIdentityDeps,
  IDENTITY_KEYS,
  CREDENTIALS_SERVICE,
  type IdentityDeps,
  type SeedResult,
} from "./claudeIdentity.js";
export {
  applyMirrorWrite,
  humanNoteArgv,
  humanNoteEnv,
  mirrorsDir,
  substituteSandbox,
} from "./world.js";
export { buildProbe, readRecordedPrs, parseTasks } from "./probe.js";
export {
  pendingReplies,
  newHumanState,
  type HumanRule,
  type HumanTaskView,
  type HumanReply,
  type HumanState,
} from "./human.js";
export { captureDay, snapshotDirFor, outRoot } from "./snapshot.js";
export type {
  Scenario,
  DayScript,
  WorldEvent,
  WorldProbe,
  SimCommand,
  SimDay,
  SimResult,
} from "./types.js";
