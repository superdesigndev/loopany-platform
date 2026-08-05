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

  it("gives a doc and a mirror ONE state each, so neither can cache a lifecycle", () => {
    expect(STATUSES_BY_KIND.doc).toEqual(["current"]);
    expect(STATUSES_BY_KIND.mirror).toEqual(["current"]);
  });

  it("starts each kind in a safe default", () => {
    // A MIRROR's single status is `current`, and the singleton is deliberate:
    // a second value here — `open`, `merged`, `stale` — would be exactly the
    // cached external state the kind exists to forbid (`kernel/mirrors.ts`).
    expect(INITIAL_STATUS).toEqual({ task: "open", doc: "current", mirror: "current" });
    for (const kind of OBJECT_KINDS) expect(STATUSES_BY_KIND[kind]).toContain(INITIAL_STATUS[kind]);
  });

  it("uses design §2's four-value entrance set, not the graph line's", () => {
    expect(ENTRANCES).toEqual(["clock", "answer", "human", "agent"]);
  });
});

describe("the transition table", () => {
  it("is the whole set of status changes — one, and no path to a second", () => {
    // ONE transition. The four loop moves retired with the loop kind: a loop's
    // lifecycle is the shipping product's (`enabled` / `completedAt` / delete).
    expect(Object.keys(TRANSITIONS).sort()).toEqual(["close"]);
  });

  it("declares close as a TASK transition only", () => {
    expect(TRANSITIONS.close.kind).toBe("task");
    expect(TRANSITIONS.close.from).toEqual(["open"]);
    expect(TRANSITIONS.close.to).toBe("closed");
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
  it("refuses task facets on a doc", () => {
    expect(firewallIssues("doc", ["pendingQuestion", "watcher", "followUpAt", "parentId"]).map((i) => i.path)).toEqual([
      "pendingQuestion",
      "watcher",
      "followUpAt",
      "parentId",
    ]);
  });

  it("refuses format on anything but a doc (design §7's narrow door)", () => {
    expect(firewallIssues("task", ["format"])).toHaveLength(1);
    expect(firewallIssues("mirror", ["format"])).toHaveLength(1);
    expect(firewallIssues("doc", ["format"])).toHaveLength(0);
  });

  it("refuses a mirror's own facets on every other kind", () => {
    expect(firewallIssues("task", ["mirrorKind", "mirrorCoords"]).map((i) => i.path)).toEqual(["mirrorKind", "mirrorCoords"]);
    expect(firewallIssues("mirror", ["mirrorKind", "mirrorCoords", "attachedTo"])).toHaveLength(0);
  });

  it("lets every kind carry the common fields", () => {
    for (const kind of OBJECT_KINDS) expect(firewallIssues(kind, ["title", "body", "payload"])).toHaveLength(0);
  });

  /** A cadence and a bound directory are the SHIPPING loop's, so they are not
   *  kernel facets at all any more — they land as an unknown key at the artifact
   *  seam, which teaches where a schedule actually lives. */
  it("teaches where a cadence lives, on every kind's hint", () => {
    expect(firewallHint("task")).toContain("follow_up");
    expect(firewallHint("task")).toContain("loopany edit");
    expect(firewallHint("doc")).toContain("loopany edit");
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
