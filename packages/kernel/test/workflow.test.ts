import { describe, expect, it } from "vitest";
import { decide, emptySnapshot, type Provenance, type Snapshot } from "../src/index.js";
import { foldChangeset } from "../src/apply.js";

const ACTOR: Provenance = { entrance: "agent-run", actorId: "run-author" };
const NOW = "2026-08-13T04:00:00.000Z";
const WF = {
  format: "loopany-js-v1" as const,
  source: 'const rows = await tools.call("posthog.query", {});\nif (rows.data) agent("review", rows.data);\nreturn { state: { cursor: 2 } };',
};

function apply(snapshot: Snapshot, command: Parameters<typeof decide>[0]): Snapshot {
  const d = decide(command, snapshot, ACTOR, NOW);
  if (!d.ok) throw new Error(`${d.refusal.code}: ${d.refusal.message}`);
  return foldChangeset(snapshot, d.changeset);
}

describe("loopany-js-v1 workflow configuration", () => {
  it("stores, replaces, and clears the versioned Task field through ordinary update", () => {
    let snapshot = apply(emptySnapshot(), { op: "create", id: "daily", title: "Daily", workflow: WF });
    expect(snapshot.objects.daily).toMatchObject({ workflow: WF });

    snapshot = apply(snapshot, {
      op: "update",
      id: "daily",
      patch: { workflow: { ...WF, source: "return { message: 'clean' };" } },
      ifVersion: 1,
    });
    expect(snapshot.objects.daily).toMatchObject({ version: 2, workflow: { format: "loopany-js-v1" } });

    snapshot = apply(snapshot, { op: "update", id: "daily", patch: { workflow: null }, ifVersion: 2 });
    expect(snapshot.objects.daily).toMatchObject({ version: 3, workflow: null });
  });

  it("refuses unknown formats and module syntax without executing source", () => {
    const badFormat = decide(
      { op: "create", title: "bad", workflow: { format: "other" as "loopany-js-v1", source: "return {};" } },
      emptySnapshot(),
      ACTOR,
      NOW,
    );
    expect(badFormat.ok).toBe(false);

    const moduleSyntax = decide(
      { op: "create", title: "bad", workflow: { format: "loopany-js-v1", source: "export default async () => {}" } },
      emptySnapshot(),
      ACTOR,
      NOW,
    );
    expect(moduleSyntax.ok).toBe(false);
  });
});
