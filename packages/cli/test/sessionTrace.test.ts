/**
 * Session TRACE rendering (axi practice: full never-clipped ids + a copyable
 * deep-dive command) and the axi-concise session-suffix rule: the kernel's
 * claim session (`spawn-<runId>`) is derivable from the actor column, so log
 * lines drop it; a NON-derivable session still renders.
 */
import { describe, expect, it } from "vitest";
import type { KernelEvent, RunRecord } from "@loopany/kernel";
import { renderEventLine, renderSessionTrace } from "../src/render.js";

const run = (over?: Partial<RunRecord>): RunRecord => ({
  id: "run-8c14",
  taskId: "bet",
  cause: "assignment",
  scheduledAt: "2026-08-12T02:21:42.872Z",
  state: "done",
  assignee: "stonex-mbp/claude",
  triggerId: null,
  createdAt: "2026-08-12T02:21:42.872Z",
  sessionId: "spawn-run-8c14",
  ...over,
});

const ev = (over?: Partial<KernelEvent>): KernelEvent => ({
  id: "e1",
  objectId: "bet",
  kind: "note",
  at: "2026-08-12T02:22:33.935Z",
  note: "did the work",
  provenance: { entrance: "agent-run", actorId: "run-8c14", sessionId: "spawn-run-8c14" },
  ...over,
});

describe("renderSessionTrace", () => {
  it("renders the FULL agent session id + the copyable transcript command", () => {
    const uuid = "60d3f5a2-1111-4222-8333-444455556666";
    const line = renderSessionTrace(run({ agentSessionId: uuid }));
    expect(line).toContain(`session ${uuid}`);
    expect(line).toContain(`find ~/.claude/projects -name '${uuid}.jsonl'`);
  });

  it("renders NOTHING when the host reported no session (replay shim, non-claude)", () => {
    expect(renderSessionTrace(run())).toBeNull();
    expect(renderSessionTrace(run({ agentSessionId: null }))).toBeNull();
  });

  it("does not invent a Claude transcript path for another provider", () => {
    const line = renderSessionTrace(run({ assignee: "stonex-mbp/codex", agentSessionId: "codex-session-1" }));
    expect(line).toBe("  session codex-session-1");
  });
});

describe("renderEventLine session suffix (axi-concise)", () => {
  it("drops the DERIVABLE claim session (spawn-<actorId>) - the actor column already says it", () => {
    const line = renderEventLine(ev());
    expect(line).toContain("agent-run:run-8c14");
    expect(line).not.toContain("session=");
  });

  it("keeps a session that says something new", () => {
    // A human-attributed write from inside a session, or a foreign host id.
    const human = renderEventLine(
      ev({ provenance: { entrance: "human", actorId: "tim@x.co", sessionId: "sess-9" } }),
    );
    expect(human).toContain("session=sess-9");
    const foreign = renderEventLine(
      ev({ provenance: { entrance: "agent-run", actorId: "run-8c14", sessionId: "other-session" } }),
    );
    expect(foreign).toContain("session=other-session");
  });

  it("no session at all renders no suffix", () => {
    const line = renderEventLine(ev({ provenance: { entrance: "human", actorId: "tim@x.co" } }));
    expect(line).not.toContain("session=");
  });
});
