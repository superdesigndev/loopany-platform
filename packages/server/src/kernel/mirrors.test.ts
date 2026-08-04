import { describe, expect, it } from "vitest";

import {
  MIRROR_KINDS,
  MIRROR_KIND_NAMES,
  MIRROR_LAW,
  knownMirrorKind,
  mirrorHref,
  mirrorKey,
  normalizeMirror,
  normalizeMirrorKind,
} from "./mirrors.js";
import { COMMON_FIELDS, MIRROR_FORBIDDEN_FIELDS, MIRROR_ONLY_FIELDS, IMMUTABLE_FIELDS, statelessIssues } from "./types.js";

/**
 * The mirror vocabulary, pure.
 *
 * Two properties carry the whole design and both are asserted structurally
 * rather than by example: kinds are FREE-FORM but mechanically normalized (so
 * the vocabulary can grow without the kernel deciding what belongs in it), and a
 * mirror has NOWHERE to record external state (so "cache it just this once"
 * cannot be written).
 */

describe("kind normalization is mechanical, and it is what makes the vocabulary self-consistent", () => {
  it("lowercases, trims and kebabs every spelling of one kind onto one row", () => {
    for (const spelling of ["github-pr", "GitHub PR", "  github_pr  ", "GitHub/PR", "github.pr", "GITHUB--PR"]) {
      expect(normalizeMirrorKind(spelling)).toBe("github-pr");
    }
  });

  it("drops characters that have no place in a slug rather than refusing them", () => {
    expect(normalizeMirrorKind("Jira Ticket!")).toBe("jira-ticket");
    expect(normalizeMirrorKind("--linear--")).toBe("linear");
  });

  // The one case normalization cannot rescue: a kind that is only punctuation
  // normalizes to the empty string, which is not a kind at all.
  it("refuses a kind that normalizes to nothing, and says why", () => {
    const result = normalizeMirror({ kind: "!!!", coords: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]).toMatchObject({ path: "kind", got: "!!!" });
  });
});

describe("a KNOWN kind gets its coords shape checked; an unknown one does not", () => {
  it("accepts the canonical shapes", () => {
    expect(normalizeMirror({ kind: "github-pr", coords: "owner/repo#57" }).ok).toBe(true);
    expect(normalizeMirror({ kind: "github-issue", coords: "super-design.dev/loopany_x#1204" }).ok).toBe(true);
    expect(normalizeMirror({ kind: "url", coords: "https://example.com/a?b=c" }).ok).toBe(true);
    expect(normalizeMirror({ kind: "gsc-property", coords: "sc-domain:example.com" }).ok).toBe(true);
  });

  it("refuses a malformed one WITH the shape it wanted — a pointer that resolves nowhere is not a pointer", () => {
    const bad = normalizeMirror({ kind: "github-pr", coords: "https://github.com/owner/repo/pull/57" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.issues[0]).toMatchObject({ path: "coords", expected: "owner/repo#57" });
    expect(normalizeMirror({ kind: "url", coords: "ftp://example.com" }).ok).toBe(false);
    // A `javascript:` "URL" is not an addressable page and must never become a
    // link the UI renders.
    expect(normalizeMirror({ kind: "url", coords: "javascript:alert(1)" }).ok).toBe(false);
  });

  /**
   * THE VOCABULARY POLICY IN ONE TEST. An unknown kind is a plain string: the
   * canonical list is teaching, and membership buys exactly one thing — a coords
   * check. Enforcing the list would mean the kernel deciding in advance every
   * external system anybody will ever depend on.
   */
  it("accepts an invented kind with any single-line coords", () => {
    const invented = normalizeMirror({ kind: "Jira Ticket", coords: "PLAT-4471", note: "the tracking ticket" });
    expect(invented.ok).toBe(true);
    expect(invented.ok && invented.value).toEqual({ kind: "jira-ticket", coords: "PLAT-4471", note: "the tracking ticket" });
    expect(knownMirrorKind("jira-ticket")).toBeUndefined();
  });
});

describe("coords are identity, so they are bounded and never rewritten", () => {
  it("trims but never case-folds — a URL path and a repo name are both case-significant", () => {
    const result = normalizeMirror({ kind: "url", coords: "  https://Example.com/Path  " });
    expect(result.ok && result.value.coords).toBe("https://Example.com/Path");
  });

  it("refuses multi-line or whitespace-bearing coords: an identity is not prose", () => {
    expect(normalizeMirror({ kind: "jira", coords: "PLAT 4471" }).ok).toBe(false);
    expect(normalizeMirror({ kind: "jira", coords: "PLAT\n4471" }).ok).toBe(false);
  });

  it("refuses an empty kind or empty coords, naming both", () => {
    const result = normalizeMirror({ kind: "", coords: "" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.map((i) => i.path)).toEqual(["kind", "coords"]);
  });

  it("is bounded, so a pasted document cannot become an identity", () => {
    expect(normalizeMirror({ kind: "url", coords: `https://example.com/${"a".repeat(600)}` }).ok).toBe(false);
  });

  /** The key is what makes (team, kind, coords) resolve to ONE row through the
   *  kernel's existing per-team key uniqueness — no second dedup path. */
  it("derives a key from kind and coords alone", () => {
    expect(mirrorKey("github-pr", "owner/repo#57")).toBe("mirror:github-pr:owner/repo#57");
  });
});

describe("href is resolved server-side, and only when the coords determine one", () => {
  it("builds the real GitHub URLs from a bare ref", () => {
    expect(mirrorHref("github-pr", "owner/repo#57")).toBe("https://github.com/owner/repo/pull/57");
    expect(mirrorHref("github-issue", "owner/repo#57")).toBe("https://github.com/owner/repo/issues/57");
  });

  it("links an unknown kind whose coords happen to be a URL, and nothing else", () => {
    expect(mirrorHref("jira-ticket", "https://jira.example.com/PLAT-1")).toBe("https://jira.example.com/PLAT-1");
    expect(mirrorHref("jira-ticket", "PLAT-4471")).toBeNull();
  });

  // The UI renders `href` into an anchor, so a non-http scheme reaching it would
  // be a script-injection surface. It is filtered at the source instead.
  it("never returns a non-http(s) scheme", () => {
    expect(mirrorHref("url", "javascript:alert(1)")).toBeNull();
    expect(mirrorHref("anything", "data:text/html,<script>")).toBeNull();
  });

  it("names every canonical kind in the teaching list", () => {
    expect(MIRROR_KIND_NAMES).toEqual(MIRROR_KINDS.map((spec) => spec.kind));
    for (const spec of MIRROR_KINDS) {
      // Each canonical entry is a promise that its coords have ONE true shape,
      // so its own example has to satisfy its own check.
      expect(spec.check(spec.example), `${spec.kind} example`).toBeUndefined();
      expect(spec.what.length).toBeGreaterThan(3);
    }
  });
});

/**
 * STATELESSNESS, at the pure altitude.
 *
 * The DDL CHECK is the floor and the integration test proves it; what is asserted
 * here is the SHAPE of the field surface — that the two open fields are subtracted
 * from a mirror and the identity fields are immutable. A future commit that wants
 * to cache a PR's status has to defeat one of these before it ever reaches SQL.
 */
describe("a mirror has nowhere to record external state", () => {
  it("subtracts exactly the two open fields every other kind has", () => {
    expect([...MIRROR_FORBIDDEN_FIELDS]).toEqual(["payload", "body"]);
    // Both ARE common fields, which is the point: the subtraction is real.
    for (const field of MIRROR_FORBIDDEN_FIELDS) expect(COMMON_FIELDS).toContain(field);
  });

  it("refuses a payload or a body on a mirror, and lets every other kind have both", () => {
    expect(statelessIssues("mirror", ["payload", "body"]).map((i) => i.path)).toEqual(["payload", "body"]);
    expect(statelessIssues("task", ["payload", "body"])).toEqual([]);
    expect(statelessIssues("doc", ["payload", "body"])).toEqual([]);
    expect(statelessIssues("loop", ["payload", "body"])).toEqual([]);
  });

  it("says WHY the field is missing rather than that it is unknown", () => {
    const [issue] = statelessIssues("mirror", ["payload"]);
    expect(issue!.message).toContain(MIRROR_LAW);
  });

  /** Its facets are the whole of it, and none of them can hold a status without
   *  lying about its own name. */
  it("has exactly three facets: the kind, the coords and the attachments", () => {
    expect([...MIRROR_ONLY_FIELDS]).toEqual(["mirrorKind", "mirrorCoords", "attachedTo"]);
  });

  it("freezes the two that are identity, leaving only the attachment set mutable", () => {
    expect(IMMUTABLE_FIELDS).toContain("mirrorKind");
    expect(IMMUTABLE_FIELDS).toContain("mirrorCoords");
    expect(IMMUTABLE_FIELDS).not.toContain("attachedTo");
  });
});
