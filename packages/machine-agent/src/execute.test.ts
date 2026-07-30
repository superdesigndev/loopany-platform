import { describe, expect, it } from "vitest";

import { parseRepoAllowlist, type AgentConfig } from "./config.js";
import { executeDirective } from "./execute.js";
import type { Gh, PrFacts } from "./gh.js";
import type { Directive } from "./types.js";

/**
 * EXECUTING ONE WORK ORDER, against a fake `gh`.
 *
 * The fake RECORDS what was called, which is what makes "executed twice ⇒ one
 * comment" a real assertion rather than a claim about the return value: the
 * second pass must not reach `comment` at all.
 */

function facts(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 7,
    state: "OPEN",
    merged: false,
    title: "a scratch change",
    baseRefName: "scratch/base",
    headRefName: "scratch/head",
    defaultBranchName: "main",
    url: "https://github.com/acme/widgets/pull/7",
    comments: [],
    ...over,
  };
}

interface Fake extends Gh {
  calls: string[];
}

function fakeGh(over: { facts?: PrFacts; commentUrl?: string; mergeThrows?: string; viewThrows?: string } = {}): Fake {
  const calls: string[] = [];
  const state = { facts: over.facts ?? facts() };
  return {
    calls,
    async view(repo, number) {
      calls.push(`view ${repo}#${number}`);
      if (over.viewThrows) throw new Error(over.viewThrows);
      return state.facts;
    },
    async comment(repo, number, body) {
      calls.push(`comment ${repo}#${number}`);
      // The real GitHub keeps the comment, so the fake does too - which is what
      // lets the second execution find its own marker.
      state.facts = { ...state.facts, comments: [...state.facts.comments, { body, url: "https://c/1" }] };
      return over.commentUrl ?? "https://c/1";
    },
    async merge(repo, number, method) {
      calls.push(`merge ${repo}#${number} ${method}`);
      if (over.mergeThrows) throw new Error(over.mergeThrows);
      state.facts = { ...state.facts, merged: true, state: "MERGED" };
      return "merged";
    },
    // The sensing read. Never reached by an effect path, and asserted so: an effect
    // that fetched a batch would be doing something nobody asked for.
    async fetchPrs(repo, numbers) {
      calls.push(`fetchPrs ${repo} [${numbers.join(",")}]`);
      return { observed: new Map(), missing: [] };
    },
  };
}

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    serverUrl: "http://127.0.0.1:3770",
    token: "t",
    agent: "probe",
    pollMs: 1000,
    allowedRepos: parseRepoAllowlist("acme/widgets"),
    allowDefaultBranch: false,
    commentOnly: false,
    sensing: false,
    sensingIntervalMs: 60_000,
    run: { args: [], maxTimeoutMs: 60_000, maxOutputBytes: 4096 },
    ...over,
  };
}

const MARKER = "<!-- loopany-effect:act-1 -->";

function directive(over: Partial<Directive> = {}): Directive {
  return {
    id: "act-1",
    kind: "github-comment",
    teamId: "team",
    objectId: "obj-mir-1",
    target: { source: "github", externalId: "acme/widgets/pull/7", repo: "acme/widgets", number: 7 },
    payload: { repo: "acme/widgets", number: 7, body: `Approved via the Loopany workspace.\n\n${MARKER}`, marker: MARKER },
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

describe("github-comment", () => {
  it("posts the body it was handed", async () => {
    const gh = fakeGh();
    const r = await executeDirective(config(), { gh }, directive());
    expect(r.ok).toBe(true);
    expect(gh.calls).toEqual(["view acme/widgets#7", "comment acme/widgets#7"]);
  });

  it("EXECUTED TWICE produces exactly ONE comment", async () => {
    const gh = fakeGh();
    const d = directive();
    await executeDirective(config(), { gh }, d);
    const second = await executeDirective(config(), { gh }, d);
    // A success - the world is as the verdict asked - but nothing was posted.
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result.alreadyDone).toBe(true);
    expect(gh.calls.filter((c) => c.startsWith("comment"))).toHaveLength(1);
  });

  it("refuses before reading anything when the approval is not human", async () => {
    const gh = fakeGh();
    const d = directive({
      approval: { eventId: "ev-1", entrance: "rule", actorId: "rule-x", ts: "t", transition: null },
    });
    const r = await executeDirective(config(), { gh }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("APPROVAL_INVALID");
    // The guard ran BEFORE the transport: an unapproved effect does not even look.
    expect(gh.calls).toEqual([]);
  });

  it("refuses a repo off the allowlist without touching GitHub", async () => {
    const gh = fakeGh();
    const d = directive({
      target: { source: "github", externalId: "other/repo/pull/1", repo: "other/repo", number: 1 },
    });
    const r = await executeDirective(config(), { gh }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REPO_NOT_ALLOWED");
    expect(gh.calls).toEqual([]);
  });

  it("reports a transport failure as retryable rather than swallowing it", async () => {
    const gh = fakeGh({ viewThrows: "connection reset" });
    const r = await executeDirective(config(), { gh }, directive());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AGENT_ERROR");
  });
});

describe("github-merge", () => {
  const mergeDirective = (over: Partial<Directive> = {}) =>
    directive({ id: "act-2", kind: "github-merge", payload: { repo: "acme/widgets", number: 7, method: "squash" }, ...over });

  it("merges a PR aimed at a scratch base", async () => {
    const gh = fakeGh();
    const r = await executeDirective(config(), { gh }, mergeDirective());
    expect(r.ok).toBe(true);
    expect(gh.calls).toContain("merge acme/widgets#7 squash");
  });

  it("REFUSES a PR aimed at the repository's default branch, without merging", async () => {
    const gh = fakeGh({ facts: facts({ baseRefName: "main" }) });
    const r = await executeDirective(config(), { gh }, mergeDirective());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DEFAULT_BRANCH_REFUSED");
    expect(gh.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("merges into the default branch when the operator explicitly allowed it", async () => {
    const gh = fakeGh({ facts: facts({ baseRefName: "main" }) });
    const r = await executeDirective(config({ allowDefaultBranch: true }), { gh }, mergeDirective());
    expect(r.ok).toBe(true);
  });

  it("EXECUTED TWICE merges once - an already-merged PR is an already-done success", async () => {
    const gh = fakeGh();
    const d = mergeDirective();
    await executeDirective(config(), { gh }, d);
    const second = await executeDirective(config(), { gh }, d);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result.alreadyDone).toBe(true);
    expect(gh.calls.filter((c) => c.startsWith("merge"))).toHaveLength(1);
  });

  it("reports GitHub's own refusal as NOT_MERGEABLE", async () => {
    const gh = fakeGh({ mergeThrows: "Pull request is not mergeable" });
    const r = await executeDirective(config(), { gh }, mergeDirective());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_MERGEABLE");
  });
});

describe("an effect kind this build does not implement", () => {
  it("REFUSES loudly rather than reporting a success nobody performed", async () => {
    const gh = fakeGh();
    const r = await executeDirective(config(), { gh }, directive({ kind: "github-close-everything" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNSUPPORTED_KIND");
  });
});
