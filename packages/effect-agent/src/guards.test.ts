import { describe, expect, it } from "vitest";

import { parseRepoAllowlist, type AgentConfig } from "./config.js";
import { checkApproval, checkMergeTarget, checkRepo, findMarkedComment } from "./guards.js";
import type { Directive } from "./types.js";

/**
 * THE GUARDS, probed directly. They are the reason this agent is a separate
 * process, so they get asserted the way an incident would find them: what does
 * each one do when it is UNSET, when it is wrong, and when somebody is trying to
 * get past it.
 */

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    serverUrl: "http://127.0.0.1:3770",
    token: "t",
    agent: "probe",
    pollMs: 1000,
    allowedRepos: parseRepoAllowlist("acme/widgets"),
    allowDefaultBranch: false,
    commentOnly: false,
    ...over,
  };
}

function directive(over: Partial<Directive> = {}): Directive {
  return {
    id: "act-1",
    kind: "github-comment",
    teamId: "team",
    objectId: "obj-mir-1",
    target: { source: "github", externalId: "acme/widgets/pull/7", repo: "acme/widgets", number: 7 },
    payload: {},
    approval: {
      eventId: "ev-1",
      entrance: "human",
      actorId: "u-captain",
      ts: "2026-07-30T09:00:00.000Z",
      transition: "approve",
    },
    attempts: 1,
    leaseExpiresAt: "2026-07-30T09:01:00.000Z",
    createdAt: "2026-07-30T09:00:00.000Z",
    ...over,
  };
}

describe("the approval re-check", () => {
  it("passes a human-entered approval with a real actor", () => {
    expect(checkApproval(directive())).toBeUndefined();
  });

  it("REFUSES a work order with no approval block at all", () => {
    const d = directive();
    delete d.approval;
    expect(checkApproval(d)?.code).toBe("APPROVAL_INVALID");
  });

  it("REFUSES a rule-entered approval - a rule cannot approve an outward effect", () => {
    const d = directive({
      approval: { eventId: "ev-1", entrance: "rule", actorId: "rule-autopilot", ts: "t", transition: null },
    });
    const r = checkApproval(d);
    expect(r?.code).toBe("APPROVAL_INVALID");
    expect(r?.error).toContain("not by a human");
  });

  it("REFUSES an approval with no actor - an unattributable approval is none", () => {
    const d = directive({
      approval: { eventId: "ev-1", entrance: "human", actorId: "   ", ts: "t", transition: "approve" },
    });
    expect(checkApproval(d)?.code).toBe("APPROVAL_INVALID");
  });
});

describe("the repo allowlist", () => {
  it("admits an allowlisted repo, case-insensitively", () => {
    expect(checkRepo(config(), "Acme/Widgets")).toBeUndefined();
  });

  it("refuses a repo that is not on it", () => {
    expect(checkRepo(config(), "acme/other")?.code).toBe("REPO_NOT_ALLOWED");
  });

  it("FAILS CLOSED on an empty allowlist, and says that is why", () => {
    const r = checkRepo(config({ allowedRepos: new Set() }), "acme/widgets");
    expect(r?.code).toBe("REPO_NOT_ALLOWED");
    expect(r?.error).toContain("EMPTY repo allowlist");
  });

  it("drops an allowlist entry it cannot interpret rather than half-matching it", () => {
    // "acme" is not an owner/name pair. Admitting it - or treating it as a prefix
    // - would widen the boundary, which is the one direction a parse bug here
    // must never fail in.
    const parsed = parseRepoAllowlist("acme, acme/widgets, https://github.com/acme/other");
    expect([...parsed]).toEqual(["acme/widgets"]);
  });
});

describe("the merge guards", () => {
  const scratch = { baseRefName: "scratch/base", defaultBranchName: "main", state: "OPEN", merged: false };

  it("allows a merge into a non-default branch", () => {
    expect(checkMergeTarget(config(), scratch)).toBeUndefined();
  });

  it("REFUSES a merge into the repository's DEFAULT branch by default", () => {
    const r = checkMergeTarget(config(), { ...scratch, baseRefName: "main" });
    expect(r?.code).toBe("DEFAULT_BRANCH_REFUSED");
  });

  it("allows the default branch only when explicitly told to", () => {
    expect(checkMergeTarget(config({ allowDefaultBranch: true }), { ...scratch, baseRefName: "main" })).toBeUndefined();
  });

  it("reads the default branch from the REPO, not from a list of likely names", () => {
    // A repo whose default is `trunk` gets the same protection - and `main` in
    // that repo is just another branch.
    const trunk = { ...scratch, baseRefName: "trunk", defaultBranchName: "trunk" };
    expect(checkMergeTarget(config(), trunk)?.code).toBe("DEFAULT_BRANCH_REFUSED");
    expect(checkMergeTarget(config(), { ...trunk, baseRefName: "main" })).toBeUndefined();
  });

  it("refuses every merge in comment-only mode, allowlist or not", () => {
    expect(checkMergeTarget(config({ commentOnly: true }), scratch)?.error).toContain("comment-only");
  });

  it("refuses a conflicting or already-closed pull request as NOT_MERGEABLE", () => {
    expect(checkMergeTarget(config(), { ...scratch, mergeable: "CONFLICTING" })?.code).toBe("NOT_MERGEABLE");
    expect(checkMergeTarget(config(), { ...scratch, state: "CLOSED" })?.code).toBe("NOT_MERGEABLE");
  });
});

describe("the comment marker", () => {
  const marker = "<!-- loopany-effect:act-1 -->";

  it("finds our own comment by identity", () => {
    const found = findMarkedComment([{ body: `hello\n${marker}`, url: "u" }], marker);
    expect(found?.url).toBe("u");
  });

  it("does not match somebody else's comment about the same PR", () => {
    expect(findMarkedComment([{ body: "Approved via the Loopany workspace.", url: "u" }], marker)).toBeUndefined();
  });

  it("matches nothing when there is no marker to look for", () => {
    expect(findMarkedComment([{ body: "anything", url: "u" }], "")).toBeUndefined();
  });
});
