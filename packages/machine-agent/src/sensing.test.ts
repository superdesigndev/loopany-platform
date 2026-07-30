import { describe, expect, it } from "vitest";

import { parseRepoAllowlist, type AgentConfig } from "./config.js";
import { batchQuery, referencedPrs, toObserved, type Gh, type PrBatch } from "./gh.js";
import { groupByRepo, sweepOnce, RATE_LIMIT_FLOOR, REPO_CONCURRENCY } from "./sensing.js";
import type { ObservedPr, WatchItem, WatchListResponse } from "./types.js";

/**
 * THE SENSING SWEEP - the fetch loop that captain decision 10 moved out of the
 * server and into this process.
 *
 * What the SERVER's own probes assert is that reporting the same facts twice writes
 * zero rows (`sensing.integration.test.ts`). What THESE assert is the half that now
 * lives here and used to live there:
 *
 *   BATCHING       one request per repo, not one per pull request
 *   RATE LIMITS    a low remaining budget stops the sweep early, mid-flight
 *   RESILIENCE     one unreachable repo does not abort the sweep over the others
 *   HONESTY        a PR the transport could not resolve is REPORTED, never guessed
 *   PARSING        GitHub's vocabulary → our closed sets, with `pending` (not
 *                  "passing") as the answer for a rollup state we do not know
 *
 * The `gh` client is faked, because the facts have to hold still for any of this to
 * be assertable - and because the whole point is that this suite runs on a machine
 * with no `gh` and no network at all.
 */

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    serverUrl: "http://127.0.0.1:3780",
    token: "t",
    agent: "probe",
    pollMs: 1000,
    allowedRepos: parseRepoAllowlist("acme/widgets"),
    allowDefaultBranch: false,
    commentOnly: false,
    sensing: true,
    sensingIntervalMs: 60_000,
    run: { args: [], maxTimeoutMs: 60_000, maxOutputBytes: 4096 },
    ...over,
  };
}

function item(repo: string, number: number, observedAt: string | null = null): WatchItem {
  return { objectId: `obj-mir-${repo}-${number}`, externalId: `${repo}/pull/${number}`, repo, number, observedAt };
}

function observed(repo: string, number: number, over: Partial<ObservedPr> = {}): ObservedPr {
  return {
    repo,
    number,
    state: "open",
    merged: false,
    checks: "pending",
    title: `PR ${number}`,
    draft: false,
    ...over,
  };
}

/** A fake `gh` over a fixed table of facts, recording every call. */
function fakeGh(
  facts: Map<string, ObservedPr>,
  over: { rateLimit?: (call: number) => number; throwsFor?: string[] } = {},
): { gh: Gh; calls: { repo: string; numbers: number[] }[] } {
  const calls: { repo: string; numbers: number[] }[] = [];
  let call = 0;
  const gh: Gh = {
    async view() {
      throw new Error("a sweep never reads a single PR");
    },
    async comment() {
      throw new Error("a sweep NEVER writes");
    },
    async merge() {
      throw new Error("a sweep NEVER writes");
    },
    async fetchPrs(repo, numbers): Promise<PrBatch> {
      call++;
      calls.push({ repo, numbers: [...numbers] });
      if (over.throwsFor?.includes(repo)) throw new Error(`cannot reach ${repo}`);
      const out = new Map<number, ObservedPr>();
      const missing: { number: number; why: string }[] = [];
      for (const n of numbers) {
        const f = facts.get(`${repo}/pull/${n}`);
        if (f) out.set(n, f);
        else missing.push({ number: n, why: "not in the probe fixture" });
      }
      return {
        observed: out,
        missing,
        ...(over.rateLimit ? { rateLimitRemaining: over.rateLimit(call) } : { rateLimitRemaining: 4000 }),
      };
    },
  };
  return { gh, calls };
}

interface Reported {
  observations: ObservedPr[];
  unresolved: { externalId: string; why: string }[];
}

function harness(items: WatchItem[], facts: Map<string, ObservedPr>, over: Parameters<typeof fakeGh>[1] = {}) {
  const { gh, calls } = fakeGh(facts, over);
  const reported: Reported[] = [];
  const lines: string[] = [];
  const list: WatchListResponse = { ok: true, teamId: "team", source: "github", items, truncated: false };
  return {
    calls,
    reported,
    lines,
    deps: {
      gh,
      log: (line: string) => lines.push(line),
      watchList: async () => list,
      report: async (input: Reported) => {
        reported.push(input);
        return {
          ok: true as const,
          mirrors: items.length,
          reported: input.observations.length,
          unknown: 0,
          changed: input.observations.length,
          events: input.observations.length * 2,
          waitsClosed: 0,
          discovered: 0,
          refusals: [],
          capped: false,
        };
      },
    },
  };
}

describe("the sweep batches by repo", () => {
  it("asks each repo ONCE, for all of its pull requests", async () => {
    const items = [item("acme/widgets", 1), item("acme/widgets", 2), item("acme/widgets", 3), item("acme/other", 41)];
    const facts = new Map(items.map((i) => [i.externalId, observed(i.repo, i.number)]));
    const h = harness(items, facts);
    const sweep = await sweepOnce(config(), h.deps);

    // Two repos, two calls - not four calls for four PRs. That is the whole reason the
    // transport is GraphQL with an aliased field per PR.
    expect(h.calls).toHaveLength(2);
    expect(h.calls.find((c) => c.repo === "acme/widgets")!.numbers).toEqual([1, 2, 3]);
    expect(sweep.repos).toBe(2);
    expect(sweep.watched).toBe(4);
    expect(sweep.reported).toBe(4);
  });

  it("reports the whole sweep in ONE call to the server", async () => {
    const items = [item("acme/widgets", 1), item("acme/other", 2)];
    const facts = new Map(items.map((i) => [i.externalId, observed(i.repo, i.number)]));
    const h = harness(items, facts);
    await sweepOnce(config(), h.deps);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]!.observations.map((o) => o.number).sort()).toEqual([1, 2]);
  });

  it("is a clean no-op on an empty watch list, with no network at all", async () => {
    const h = harness([], new Map());
    const sweep = await sweepOnce(config(), h.deps);
    expect(sweep).toMatchObject({ watched: 0, repos: 0, reported: 0, changed: 0, events: 0 });
    expect(h.calls).toHaveLength(0);
    expect(h.reported).toHaveLength(0);
  });

  it("drops a watch item it cannot address", () => {
    // A malformed entry must never widen what is fetched, and must never be guessed
    // at either - it simply is not a pull request this transport understands.
    const grouped = groupByRepo([
      item("acme/widgets", 1),
      { objectId: "x", externalId: "nonsense", repo: "not-a-repo", number: 2, observedAt: null },
      { objectId: "y", externalId: "z", repo: "acme/widgets", number: -1, observedAt: null },
    ]);
    expect([...grouped.entries()]).toEqual([["acme/widgets", [1]]]);
  });
});

describe("the sweep protects a shared rate-limit budget", () => {
  it("STOPS EARLY when the remaining budget falls below the floor", async () => {
    // Enough repos to need several concurrency groups, so the stop can actually be
    // observed mid-flight rather than after everything was fetched anyway.
    const repos = Array.from({ length: REPO_CONCURRENCY * 3 }, (_, i) => `acme/r${i}`);
    const items = repos.map((r, i) => item(r, i + 1));
    const facts = new Map(items.map((i) => [i.externalId, observed(i.repo, i.number)]));
    const h = harness(items, facts, { rateLimit: () => RATE_LIMIT_FLOOR - 1 });

    const sweep = await sweepOnce(config(), h.deps);
    expect(sweep.rateLimited).toBe(true);
    // The first group ran; the rest did not. Stopping is safe by construction: the
    // mirrors we did not reach keep their old facts and the next sweep observes them.
    expect(h.calls).toHaveLength(REPO_CONCURRENCY);
    expect(h.lines.some((l) => l.includes("stopping the sweep early"))).toBe(true);
    // What it DID read is still reported - a partial sweep is not a wasted one.
    expect(h.reported[0]!.observations).toHaveLength(REPO_CONCURRENCY);
  });

  it("keeps going while the budget is healthy", async () => {
    const repos = Array.from({ length: REPO_CONCURRENCY * 2 }, (_, i) => `acme/r${i}`);
    const items = repos.map((r, i) => item(r, i + 1));
    const facts = new Map(items.map((i) => [i.externalId, observed(i.repo, i.number)]));
    const h = harness(items, facts, { rateLimit: () => 4000 });
    const sweep = await sweepOnce(config(), h.deps);
    expect(sweep.rateLimited).toBe(false);
    expect(h.calls).toHaveLength(REPO_CONCURRENCY * 2);
  });
});

describe("the sweep is honest about what it could not read", () => {
  it("one unreachable repo does not abort the sweep over the others", async () => {
    const items = [item("acme/widgets", 1), item("acme/broken", 2)];
    const facts = new Map([[items[0]!.externalId, observed("acme/widgets", 1)]]);
    const h = harness(items, facts, { throwsFor: ["acme/broken"] });

    const sweep = await sweepOnce(config(), h.deps);
    // The good repo's facts landed…
    expect(h.reported[0]!.observations.map((o) => o.repo)).toEqual(["acme/widgets"]);
    // …and the bad one is reported as unresolved, with the reason, rather than
    // silently missing or fabricated as `closed`.
    expect(sweep.unresolved).toEqual([{ externalId: "acme/broken/pull/2", why: "cannot reach acme/broken" }]);
    expect(h.reported[0]!.unresolved).toEqual(sweep.unresolved);
  });

  it("reports an unresolved-only sweep, because 'we could not read these' is a fact too", async () => {
    const items = [item("acme/widgets", 9)];
    const h = harness(items, new Map());
    await sweepOnce(config(), h.deps);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]!.observations).toHaveLength(0);
    expect(h.reported[0]!.unresolved).toHaveLength(1);
  });

  it("sweeps a repo this agent may not WRITE to", async () => {
    // Sensing is read-only, so the effect allowlist deliberately does not gate it: a
    // team watching a repo it cannot merge into must still see that PR move. Refusing
    // to observe would leave the mirror permanently stale for no safety gain.
    const items = [item("someone/else", 5)];
    const facts = new Map([[items[0]!.externalId, observed("someone/else", 5, { state: "merged", merged: true })]]);
    const h = harness(items, facts);
    const sweep = await sweepOnce(config({ allowedRepos: parseRepoAllowlist("acme/widgets") }), h.deps);
    expect(sweep.reported).toBe(1);
    expect(h.reported[0]!.observations[0]!.merged).toBe(true);
  });
});

describe("parsing GitHub's answers into our closed sets", () => {
  it("collapses the state and keeps `merged` as its own fact", () => {
    expect(toObserved("acme/widgets", { number: 1, state: "MERGED", merged: true })!.state).toBe("merged");
    expect(toObserved("acme/widgets", { number: 1, state: "CLOSED", merged: false })!.state).toBe("closed");
    expect(toObserved("acme/widgets", { number: 1, state: "OPEN", merged: false })!.state).toBe("open");
    // A disagreement between the two is visible rather than folded: `merged: true`
    // wins on the projection, and the boolean is carried besides.
    const odd = toObserved("acme/widgets", { number: 1, state: "OPEN", merged: true })!;
    expect(odd.state).toBe("merged");
    expect(odd.merged).toBe(true);
  });

  it("never claims green for a rollup state it does not recognise", () => {
    const checks = (state?: string) =>
      toObserved("acme/widgets", {
        number: 1,
        state: "OPEN",
        commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
      })!.checks;
    expect(checks("SUCCESS")).toBe("passing");
    expect(checks("FAILURE")).toBe("failing");
    expect(checks("ERROR")).toBe("failing");
    // No rollup at all means no CI on that commit - a real answer, not "unknown".
    expect(checks(undefined)).toBe("none");
    // Something this build has never seen. "I do not know yet" is the honest reading,
    // and it must never resolve to `passing`.
    expect(checks("SOMETHING_NEW")).toBe("pending");
  });

  it("returns undefined for a node it cannot trust", () => {
    expect(toObserved("acme/widgets", null)).toBeUndefined();
    expect(toObserved("acme/widgets", {})).toBeUndefined();
  });

  it("builds one aliased field per PR plus the live rate-limit block", () => {
    const q = batchQuery("acme/widgets", [1, 2]);
    expect(q).toContain("p1: pullRequest(number: 1)");
    expect(q).toContain("p2: pullRequest(number: 2)");
    expect(q).toContain("rateLimit { remaining cost }");
    // READ-ONLY BY CONSTRUCTION: there is no mutation text on this path at all.
    expect(q).not.toMatch(/mutation/i);
  });

  it("finds cross-references in prose, bounded, and never invents a repo", () => {
    const refs = referencedPrs(
      { repo: "acme/widgets", number: 7 },
      "Follows https://github.com/acme/other/pull/12 and supersedes #5. See also #7.",
    );
    expect(refs).toEqual([
      { repo: "acme/other", number: 12 },
      { repo: "acme/widgets", number: 5 },
    ]);
    // `#7` is itself - never a self-reference.
    expect(refs.some((r) => r.number === 7)).toBe(false);
    // Bounded, so a body listing a release train cannot become forty mirrors.
    const many = referencedPrs({ repo: "acme/widgets", number: 1 }, Array.from({ length: 40 }, (_, i) => `#${i + 2}`).join(" "));
    expect(many).toHaveLength(5);
  });
});
