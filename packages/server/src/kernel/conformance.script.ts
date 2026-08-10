/**
 * The GOLDEN CONFORMANCE SCRIPT — the M6 acceptance gate's shared input (§13).
 *
 * This is the ONE command sequence that BOTH backends must execute identically:
 * the local `.loopany/` file driver and the in-process server HTTP route. It
 * mirrors the kernel's own `test/golden.test.ts` SEO two-loop scenario (v1 §6.4)
 * — a bet manager loop opens a bet, the bet scores daily via a once-trigger tick
 * loop, wins on day 7, a human approves the engine, the engine loop is born, the
 * bet dies done — including the TICKS (the clock's fires), so the trigger/run
 * machinery is exercised end to end.
 *
 * Expressed as DATA (not code) so a single driver-agnostic runner (both backends)
 * can replay it. Each step is a write `Command` OR a host `tick`, tagged with the
 * ACTOR and the deterministic `now`. Provenance sessionIds are pinned so the
 * per-object event provenance sequences compare byte-for-byte across backends.
 *
 * A separate `BAD_COMMANDS` list drives refusal parity: the same malformed /
 * illegal commands must be REFUSED with the SAME code by both backends (the
 * kernel is pure and runs at each authority, so a refusal can never diverge — the
 * conformance suite proves it).
 */
import { type Command, type Provenance, mirrorId } from "@loopany/kernel";

export const OWNER: Provenance = { entrance: "human", actorId: "u-tim" };
export const RUN = (n: number): Provenance => ({
  entrance: "agent-run",
  actorId: `run-${n}`,
  sessionId: `sess-${n}`,
});

/** One replayable step: a write command or a host tick, at a pinned instant. */
export type ScriptStep =
  | { kind: "command"; command: Command; actor: Provenance; now: string }
  | { kind: "tick"; now: string };

// The bet's tracked PR is a mirror; its id is deterministic (m-<hash(kind,coords)>)
// so the `tracks` reference resolves the same on both backends without reading
// the snapshot back mid-script.
const PR_ID = mirrorId("github-pr", "site#611");

const d0 = "2026-08-03T09:00:00.000Z";
/** The script's first instant — the workspace-init timestamp both runners use. */
export const SCRIPT_START = d0;
const d7 = "2026-08-09T07:30:00.000Z";
const d8 = "2026-08-09T12:00:00.000Z";
const d9 = "2026-08-09T12:10:00.000Z";

function daily(): ScriptStep[] {
  const steps: ScriptStep[] = [];
  // Days 2..7: the once trigger fires daily; the agent observes and re-arms.
  for (let day = 4; day <= 9; day++) {
    const at = `2026-08-${String(day).padStart(2, "0")}T07:05:00.000Z`;
    steps.push({ kind: "tick", now: at });
    if (day < 9) {
      steps.push({
        kind: "command",
        actor: RUN(day),
        now: at,
        command: {
          op: "note",
          id: "bet-claude-code-design-prompts",
          note: `day${day - 3}: series read`,
          observation: { observedAt: at, sourceRevision: `gsc-${day}`, facts: { imp: day * 7 } },
        },
      });
      steps.push({
        kind: "command",
        actor: RUN(day),
        now: at,
        command: {
          op: "update",
          id: "bet-claude-code-design-prompts",
          patch: {
            status: "follow-up",
            followUpAt: `2026-08-${String(day + 1).padStart(2, "0")}T07:00:00.000Z`,
          },
        },
      });
    }
  }
  return steps;
}

/** The full SEO two-loop lifecycle as a driver-agnostic step list. */
export const GOLDEN_SCRIPT: readonly ScriptStep[] = [
  // Monday: the bet manager loop exists; its run opens a bet.
  {
    kind: "command",
    actor: OWNER,
    now: d0,
    command: {
      op: "create",
      title: "seo bet manager",
      cron: "0 9 * * 1",
      timezone: "UTC",
      status: "in-progress",
      assignee: "mbp/claude",
    },
  },
  {
    kind: "command",
    actor: RUN(1),
    now: d0,
    command: { op: "doc-put", key: "seo bet ledger", body: "term | thesis | verdict\n" },
  },
  {
    kind: "command",
    actor: RUN(1),
    now: d0,
    command: { op: "mirror-add", kind: "github-pr", coords: "site#611" },
  },
  {
    kind: "command",
    actor: RUN(1),
    now: d0,
    command: {
      op: "create",
      title: "bet: claude code design prompts",
      parent: "seo-bet-manager",
      tracks: PR_ID,
      assignee: "mbp/claude",
      followUpAt: "2026-08-04T07:00:00.000Z",
      body: "thesis: emerging head term",
    },
  },
  ...daily(),
  // Day 7: SCALE verdict — ledger row, approval shepherd to the owner, bet closes.
  {
    kind: "command",
    actor: RUN(9),
    now: d7,
    command: {
      op: "doc-put",
      key: "seo bet ledger",
      body: "term | thesis | verdict\nccdp | emerging | SCALE\n",
    },
  },
  {
    kind: "command",
    actor: RUN(9),
    now: d7,
    command: {
      op: "create",
      title: "approve engine: ccdp",
      tracks: "seo-bet-ledger",
      assignee: "tim@x.com",
      parent: "seo-bet-manager",
    },
  },
  {
    kind: "command",
    actor: RUN(9),
    now: d7,
    command: {
      op: "update",
      id: "bet-claude-code-design-prompts",
      patch: { status: "done" },
      note: "SCALE — handed to owner gate",
    },
  },
  // Tim approves by handing it back to the agent (assignment IS dispatch).
  {
    kind: "command",
    actor: OWNER,
    now: d8,
    command: {
      op: "update",
      id: "approve-engine-ccdp",
      patch: { assignee: "mbp/claude" },
      note: "approved",
    },
  },
  // The dispatched run births the engine (loop birth = create --cron) and closes
  // the shepherd.
  {
    kind: "command",
    actor: RUN(10),
    now: d9,
    command: {
      op: "create",
      title: "seo engine ccdp",
      cron: "0 9 * * 3",
      timezone: "UTC",
      status: "in-progress",
      assignee: "mbp/claude",
      body: "regime: land-grab",
    },
  },
  {
    kind: "command",
    actor: RUN(10),
    now: d9,
    command: {
      op: "update",
      id: "approve-engine-ccdp",
      patch: { status: "done" },
      note: "engine born",
    },
  },
];

/** Deliberate bad commands for refusal parity. Each MUST be refused with the
 *  SAME code by both backends. Run AFTER the golden script (so the objects the
 *  illegal commands reference exist), each against the post-script state — none
 *  of these persist (a refusal produces no changeset). */
export interface BadCommandCase {
  readonly label: string;
  readonly command: Command;
  readonly actor: Provenance;
  readonly now: string;
  /** The Refusal code both backends must return. */
  readonly code: string;
}

export const BAD_COMMANDS: readonly BadCommandCase[] = [
  {
    label: "delete is taught, not honored",
    command: { op: "delete", id: "seo-bet-manager" },
    actor: OWNER,
    now: d9,
    code: "DELETE_TAUGHT",
  },
  {
    label: "unknown object update refuses",
    command: { op: "update", id: "no-such-task", patch: { status: "done" } },
    actor: OWNER,
    now: d9,
    code: "UNKNOWN_OBJECT",
  },
  {
    label: "a malformed command refuses without throwing",
    command: { op: "nonsense" } as unknown as Command,
    actor: OWNER,
    now: d9,
    code: "UNKNOWN_COMMAND",
  },
  {
    label: "an invalid status is rejected",
    command: { op: "update", id: "seo-bet-manager", patch: { status: "banana" } },
    actor: OWNER,
    now: d9,
    code: "INVALID_STATUS",
  },
  {
    label: "an unknown mirror kind is rejected",
    command: { op: "mirror-add", kind: "not-a-kind", coords: "x/y" },
    actor: OWNER,
    now: d9,
    code: "BAD_MIRROR_KIND",
  },
];
