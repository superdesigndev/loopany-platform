import { describe, expect, it } from "vitest";

import { parseFields, parseFlags } from "./cli.js";
import { runCliToken, runCliTokenMatches } from "./identity.js";
import { ALL_VERBS, ROLE_VERBS, VERBS, roleMayCall, verbSection, verbsForRole } from "./roles.js";
import { composeWorkOrderIntent, hasWorkOrderInstance } from "./workOrder.js";

/**
 * PROBE SUITE — the PURE half of the `graph` CLI: argv parsing, the role fence,
 * the run credential, and the work-order composer.
 *
 * Everything here runs without a database, which is the point: these are the
 * parts an agent hits first and the parts whose failures are silent. A flag that
 * is quietly dropped, a role that quietly widens, a credential that quietly
 * matches the wrong run - none of those throw, and all of them are the class of
 * bug captain decision 15(c) says must never happen.
 *
 * The database-backed half (what each verb actually writes) is
 * `verbs.integration.test.ts`.
 */

const TASK_CREATE = { value: ["type", "title", "key", "for", "field"], boolean: [], positional: 0 };

describe("probe: a flag is never silently dropped", () => {
  it("refuses an unknown flag and names what the verb does take", () => {
    const r = parseFlags(["--questoin", "hello"], { value: ["question"], boolean: [], positional: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The typo is named AND the real flag is offered - a run that misspells one
    // flag should not have to guess twice.
    expect(r.why).toContain("--questoin");
    expect(r.why).toContain("--question");
  });

  it("takes both --k v and --k=v, and refuses a value on a switch", () => {
    const spaced = parseFlags(["--type", "task"], TASK_CREATE);
    const inline = parseFlags(["--type=task"], TASK_CREATE);
    expect(spaced.ok && spaced.flags.get("type")).toBe("task");
    expect(inline.ok && inline.flags.get("type")).toBe("task");

    const bad = parseFlags(["--json=yes"], { value: [], boolean: [], positional: 0 });
    expect(bad.ok).toBe(false);
  });

  it("refuses a value flag with nothing after it", () => {
    const r = parseFlags(["--title"], TASK_CREATE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("needs a value");
  });

  it("refuses more positionals than the verb takes", () => {
    const r = parseFlags(["a", "b", "c"], { value: [], boolean: [], positional: 2 });
    expect(r.ok).toBe(false);
  });

  it("keeps every --field occurrence and types the values", () => {
    const r = parseFlags(
      ["--field", "repo=acme/widgets", "--field", "number=7", "--field", "mergeIntent=true", "--field", "note=a, b"],
      TASK_CREATE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Typed, so instance data can carry a domain without a schema per domain
    // (captain decision 17).
    expect(parseFields(r.flags)).toEqual({
      repo: "acme/widgets",
      number: 7,
      mergeIntent: true,
      note: "a, b",
    });
  });
});

describe("probe: the role fence is real, not advisory", () => {
  it("gives each role one to three verbs, never seven", () => {
    for (const [role, verbs] of Object.entries(ROLE_VERBS)) {
      expect(verbs.length).toBeGreaterThan(0);
      expect(verbs.length).toBeLessThan(ALL_VERBS.length);
      // Every advertised verb must exist, or a work order would print a command
      // the router refuses.
      for (const v of verbs) expect(VERBS[v]).toBeDefined();
      expect(role).toMatch(/^(discovery|fix|watch)$/);
    }
  });

  it("refuses a verb outside the role, and an UNSET role gets nothing at all", () => {
    expect(roleMayCall("discovery", "task create")).toBe(true);
    expect(roleMayCall("discovery", "wait open")).toBe(false);
    expect(roleMayCall("watch", "wait answer")).toBe(true);
    expect(roleMayCall("watch", "task create")).toBe(false);
    // FAIL-CLOSED: a work order that forgot to name a role must not get all seven.
    expect(roleMayCall(undefined, "task create")).toBe(false);
    expect(verbsForRole(undefined)).toEqual([]);
  });

  it("prints only the role's verbs into a work order, with a line each", () => {
    const section = verbSection("watch").join("\n");
    expect(section).toContain("graph wait answer");
    expect(section).toContain("graph artifact push");
    expect(section).not.toContain("graph task create");
    expect(section).not.toContain("graph review request");
    // The self-guiding contract is stated where the run reads it (decision 15b).
    expect(section).toContain("prints what to do next");
    expect(section).toContain("A refusal prints what you MAY do instead");
  });
});

describe("probe: the run credential names exactly one run", () => {
  it("matches its own run and nothing else", () => {
    const token = runCliToken("channel-secret", "run-abc");
    expect(token.startsWith("rt_")).toBe(true);
    expect(runCliTokenMatches(token, "channel-secret", "run-abc")).toBe(true);
    expect(runCliTokenMatches(`Bearer ${token}`, "channel-secret", "run-abc")).toBe(true);
    // A token for a DIFFERENT run does not work here, which is what makes it a
    // per-run credential rather than a shared one with extra steps.
    expect(runCliTokenMatches(token, "channel-secret", "run-xyz")).toBe(false);
    // Nor does it survive a different channel secret.
    expect(runCliTokenMatches(token, "another-secret", "run-abc")).toBe(false);
    expect(runCliTokenMatches(undefined, "channel-secret", "run-abc")).toBe(false);
    expect(runCliTokenMatches("rt_short", "channel-secret", "run-abc")).toBe(false);
  });

  it("is the SAME derivation the machine agent computes", () => {
    // A GOLDEN VECTOR, and the machine agent's own suite pins the identical
    // string. The two implementations are deliberately separate (the agent must
    // not depend on the server's source), so this pair is what keeps them honest:
    // a change on either side fails both suites.
    expect(runCliToken("probe-channel-secret", "run-abc")).toBe("rt_d6a9f4bbe5d47860346705bb1a8a5654");
  });
});

describe("probe: workflow instructions are DATA", () => {
  it("composes the core, then the loop's own workflow, then its verbs", () => {
    const intent = composeWorkOrderIntent("CORE: do the standing thing.", {
      role: "fix",
      workflow: "Work in a fresh worktree. Open one PR. Never stack a second.",
    });
    const core = intent.indexOf("CORE:");
    const workflow = intent.indexOf("Work in a fresh worktree");
    const verbs = intent.indexOf("# Your commands");
    // ORDER IS LOAD-BEARING: an instruction whose first paragraph is instance
    // prose is one where a loop can talk its own run out of the disciplines.
    expect(core).toBeGreaterThanOrEqual(0);
    expect(workflow).toBeGreaterThan(core);
    expect(verbs).toBeGreaterThan(workflow);
    expect(intent).toContain("graph mirror track");
    expect(intent).not.toContain("graph wait open");
  });

  it("leaves an instance with neither role nor workflow completely untouched", () => {
    expect(hasWorkOrderInstance({})).toBe(false);
    expect(hasWorkOrderInstance({ workflow: "   " })).toBe(false);
    expect(hasWorkOrderInstance({ role: "watch" })).toBe(true);
    // The additive guarantee: a loop that predates this composes to itself.
    expect(composeWorkOrderIntent("CORE", {})).toBe("CORE");
  });
});
