/**
 * The kernel's pure vocabulary — the transition table and the kind firewalls,
 * asserted without a database.
 *
 * These are the rules design §3 and §4 name, and the reason they live in a pure
 * module is that a firewall you can only exercise through a transaction is a
 * firewall nobody exercises.
 */
import { describe, expect, it } from "vitest";

import {
  ENTRANCES,
  INITIAL_STATUS,
  OBJECT_KINDS,
  STATUSES_BY_KIND,
  TRANSITIONS,
  firewallHint,
  firewallIssues,
  hasOpenQuestion,
  immutableIssues,
  isTransitionName,
  refuse,
} from "./types.js";

describe("the state shape", () => {
  it("gives a task exactly two states (design §3: open → closed, nothing else)", () => {
    expect(STATUSES_BY_KIND.task).toEqual(["open", "closed"]);
  });

  it("gives a loop an OPERATIONAL lifecycle that never closes", () => {
    expect(STATUSES_BY_KIND.loop).toEqual(["active", "paused", "retired"]);
    expect(STATUSES_BY_KIND.loop).not.toContain("closed");
  });

  it("starts each kind in a safe default", () => {
    // A MIRROR's single status is `current`, and the singleton is deliberate:
    // a second value here — `open`, `merged`, `stale` — would be exactly the
    // cached external state the kind exists to forbid (`kernel/mirrors.ts`).
    expect(INITIAL_STATUS).toEqual({ task: "open", loop: "active", doc: "current", mirror: "current" });
    for (const kind of OBJECT_KINDS) expect(STATUSES_BY_KIND[kind]).toContain(INITIAL_STATUS[kind]);
  });

  it("uses design §2's four-value entrance set, not the graph line's", () => {
    expect(ENTRANCES).toEqual(["clock", "answer", "human", "agent"]);
  });
});

describe("the transition table", () => {
  it("is the whole set of status changes — five, and no path to a sixth", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(["auto-pause", "close", "pause", "resume", "retire"]);
  });

  it("declares close as a TASK transition only (loops pause/retire instead)", () => {
    expect(TRANSITIONS.close.kind).toBe("task");
    expect(TRANSITIONS.close.from).toEqual(["open"]);
    expect(TRANSITIONS.close.to).toBe("closed");
  });

  it("keeps auto-pause a distinct NAME from pause, so the timeline can tell them apart", () => {
    expect(TRANSITIONS["auto-pause"].to).toBe(TRANSITIONS.pause.to);
    expect(Object.keys(TRANSITIONS)).toContain("auto-pause");
  });

  it("lands every transition inside its kind's declared status set", () => {
    for (const [name, spec] of Object.entries(TRANSITIONS)) {
      expect(STATUSES_BY_KIND[spec.kind], name).toContain(spec.to);
      for (const from of spec.from) expect(STATUSES_BY_KIND[spec.kind], `${name}.from`).toContain(from);
    }
  });

  it("never routes a task transition out of a terminal state", () => {
    expect(TRANSITIONS.close.from).not.toContain("closed");
  });

  it("recognizes only real names", () => {
    expect(isTransitionName("close")).toBe(true);
    expect(isTransitionName("reopen")).toBe(false);
    expect(isTransitionName("toString")).toBe(false); // prototype keys are not transitions
  });
});

describe("the kind firewalls (design §4 rule 2)", () => {
  it("refuses a cadence on a task and teaches where one lives", () => {
    const issues = firewallIssues("task", ["cron"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("cron");
    expect(issues[0]!.message).toContain("cadence belongs to a loop");
    expect(firewallHint("task")).toContain("follow_up");
  });

  it("refuses timezone and next_fire on a task too — the whole cadence facet", () => {
    expect(firewallIssues("task", ["timezone", "nextFire"]).map((i) => i.path)).toEqual(["timezone", "nextFire"]);
  });

  it("refuses task facets on a loop", () => {
    expect(firewallIssues("loop", ["pendingQuestion", "watcher", "followUpAt"]).map((i) => i.path)).toEqual([
      "pendingQuestion",
      "watcher",
      "followUpAt",
    ]);
  });

  it("refuses format on anything but a doc (design §7's narrow door)", () => {
    expect(firewallIssues("task", ["format"])).toHaveLength(1);
    expect(firewallIssues("loop", ["format"])).toHaveLength(1);
    expect(firewallIssues("doc", ["format"])).toHaveLength(0);
  });

  it("lets every kind carry the common fields", () => {
    for (const kind of OBJECT_KINDS) expect(firewallIssues(kind, ["title", "body", "payload"])).toHaveLength(0);
  });

  it("lets a loop carry its own cadence and a task its own facets", () => {
    expect(firewallIssues("loop", ["cron", "timezone", "nextFire"])).toHaveLength(0);
    expect(firewallIssues("task", ["followUpAt", "pendingQuestion", "watcher"])).toHaveLength(0);
  });
});

describe("immutable fields", () => {
  it("names status, so a content write can never smuggle a state change", () => {
    const issues = immutableIssues(["status", "title"]);
    expect(issues.map((i) => i.path)).toEqual(["status"]);
    expect(issues[0]!.message).toContain("transition");
  });

  it("names identity", () => {
    expect(immutableIssues(["id", "kind", "key", "teamId"]).map((i) => i.path)).toEqual([
      "id",
      "kind",
      "key",
      "teamId",
    ]);
  });
});

describe("hasOpenQuestion", () => {
  it("treats absent, empty and whitespace-only alike — all three mean no question", () => {
    expect(hasOpenQuestion(null)).toBe(false);
    expect(hasOpenQuestion(undefined)).toBe(false);
    expect(hasOpenQuestion("")).toBe(false);
    expect(hasOpenQuestion("   \n ")).toBe(false);
  });

  it("is true for real prose", () => {
    expect(hasOpenQuestion("(a) revert (b) one more day")).toBe(true);
  });
});

describe("the refusal envelope (spec §3.1)", () => {
  it("always carries issues, and a hint only when there is one", () => {
    expect(refuse("CLOSED", "closed")).toEqual({ ok: false, code: "CLOSED", message: "closed", issues: [] });
    expect(refuse("CLOSED", "closed", [], "do this instead").hint).toBe("do this instead");
  });
});
