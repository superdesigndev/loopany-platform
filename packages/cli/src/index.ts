/**
 * @loopany/cli — the kernel CLI + local file driver.
 *
 * The DRIVER is exported for reuse by the M6 conformance harness (which drives
 * the same golden command script against both the local and the server
 * backends). The CLI `run(argv, deps)` is exported so it can be tested against a
 * temp dir without spawning a process. The object-file seam (over the shared
 * @loopany/artifact-format codec) is exported so the conformance harness can
 * assert file-shape invariants.
 */
export { run, type CliDeps, type CliOutcome } from "./cli.js";
export {
  DriverError,
  WORKSPACE_DIR,
  type CommandResult,
  type WorkspaceConfig,
  conflictToError,
  findWorkspace,
  initWorkspace,
  loadEvents,
  loadSnapshot,
  readConfig,
  readSnapshot,
  refusalToError,
  requireWorkspace,
  runCommand,
  runTick,
  type TickResultReport,
} from "./driver.js";
export {
  CodecError,
  objectToDocument,
  documentToObject,
  parseObject,
  serializeObject,
} from "./objectFile.js";
export {
  buildCorePrompt,
  buildCorePromptForRun,
  deriveScenario,
  scenarioRule,
  wakeReasonFor,
  type Scenario,
} from "./prompt.js";
export {
  realSpawn,
  readProfiles,
  spawnPendingRuns,
  buildSpawnRequest,
  type Profile,
  type Profiles,
  type SpawnFn,
  type SpawnRequest,
  type SpawnResult,
  type SpawnReport,
  type SpawnedRun,
} from "./spawn.js";
export {
  readRegistry,
  registerWorkspace,
  unregisterWorkspace,
  registryPath,
  type RegistryEntry,
  type RegistryDeps,
} from "./registry.js";
export { realProbe, seedProfiles, type ProbeFn } from "./seedProfiles.js";
