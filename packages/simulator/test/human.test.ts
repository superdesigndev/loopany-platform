/**
 * HUMAN ACTOR - the rule table fires ONCE per (rule,task), respects the day
 * delay, and only scans tasks assigned to the rule's actor.
 */

import { describe, expect, it } from "vitest";
import { humanTaskViews } from "../src/engine.js";
import {
  newHumanState,
  pendingReplies,
  type HumanRule,
  type HumanTaskView,
} from "../src/human.js";

const RULE: HumanRule = {
  actor: "tim",
  match: "regression",
  delayDays: 0,
  reply: "fix it, report the recovery",
  reassignTo: "claude",
};

function task(id: string, assignee: string | null, text = ""): HumanTaskView {
  return { id, assignee, text: `${id} ${text}`.toLowerCase() };
}

describe("pendingReplies", () => {
  it("fires for a matching task assigned to the actor, reassigns back", () => {
    const state = newHumanState();
    const replies = pendingReplies([RULE], [task("q-regression-1", "tim")], 0, state);
    expect(replies).toHaveLength(1);
    expect(replies[0].taskId).toBe("q-regression-1");
    expect(replies[0].reassignTo).toBe("claude");
    expect(replies[0].reply).toContain("fix it");
  });

  it("fires ONCE - a second scan the next day is silent", () => {
    const state = newHumanState();
    const t = [task("q-regression-1", "tim")];
    expect(pendingReplies([RULE], t, 0, state)).toHaveLength(1);
    expect(pendingReplies([RULE], t, 1, state)).toHaveLength(0);
  });

  it("respects delayDays - defers until the delay has elapsed", () => {
    const delayed: HumanRule = { ...RULE, delayDays: 1 };
    const state = newHumanState();
    const t = [task("q-regression-1", "tim")];
    // Day 0: matched but not yet due.
    expect(pendingReplies([delayed], t, 0, state)).toHaveLength(0);
    // Day 1: one day elapsed -> fires.
    expect(pendingReplies([delayed], t, 1, state)).toHaveLength(1);
  });

  it("ignores tasks not assigned to the actor", () => {
    const state = newHumanState();
    const replies = pendingReplies([RULE], [task("q-regression-1", "claude")], 0, state);
    expect(replies).toHaveLength(0);
  });

  it("matches against the task text, not just the id", () => {
    const state = newHumanState();
    const replies = pendingReplies(
      [RULE],
      [task("q-123", "tim", "safari regression escalation")],
      0,
      state,
    );
    expect(replies).toHaveLength(1);
  });
});

describe("humanTaskViews", () => {
  it("parses the REAL tree wire shape: fields under .task, children on the node", () => {
    // Verbatim structure of `lk list --json` (haiku-1 postmortem fixture).
    const wire = JSON.stringify([
      {
        task: { archetype: "task", id: "release-radar", title: "release radar", status: "in-progress", assignee: "claude" },
        children: [
          {
            task: { archetype: "task", id: "assess-regression-risk", title: "Assess regression risk", status: "todo", assignee: "tim" },
            children: [],
          },
        ],
      },
    ]);
    const views = humanTaskViews(wire);
    expect(views.map((v) => `${v.id}@${v.assignee}`)).toEqual([
      "release-radar@claude",
      "assess-regression-risk@tim",
    ]);
    // The parsed views must satisfy the rule scan end to end.
    const replies = pendingReplies([RULE], views, 0, newHumanState());
    expect(replies).toHaveLength(1);
    expect(replies[0].taskId).toBe("assess-regression-risk");
  });

  it("returns [] on junk without throwing", () => {
    expect(humanTaskViews("not json")).toEqual([]);
    expect(humanTaskViews("{}")).toEqual([]);
  });
});
