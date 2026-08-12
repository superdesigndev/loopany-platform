/**
 * Runs through the same real tsx loader as bin/loopany-kernel.mjs. Vitest's JSX
 * transform can mask a missing React binding, so this fixture must stay a child
 * process rather than being imported by a test.
 */
import { emptySnapshot } from "@loopany/kernel";
import type { Backend } from "../../src/backend.js";
import { startKanban, type KanbanRenderer } from "../../src/kanban/app.js";

const backend = {
  snapshot: () => emptySnapshot(),
  events: () => [],
} as unknown as Backend;

const renderer: KanbanRenderer = (_node, options) => {
  if (options?.alternateScreen !== true || options.interactive !== true) {
    throw new Error("kanban renderer options are not interactive alternate-screen mode");
  }
  return { waitUntilExit: async () => undefined };
};

await startKanban(backend, null, renderer);
process.stdout.write("kanban runtime loaded\n");
