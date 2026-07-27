import { describe, expect, it } from "vitest";

import {
  appendTimeline,
  patchFrontmatter,
  readFrontmatter,
  scaffoldReadme,
  slugify,
  stripTimelineSection,
  titleSimilarity,
} from "./taskfile.js";

const README = [
  "---",
  "id: cheap-geo-ppp",
  "title: Cheap geo PPP",
  "type: experiment",
  "status: todo",
  "priority: P2",
  "custom_key: kept-verbatim",
  "---",
  "",
  "## Spec",
  "Try PPP pricing.",
  "",
  "## Current understanding",
  "Nothing yet.",
  "",
  "## Timeline",
  "- 2026-07-01 | Created.",
  "",
].join("\n");

describe("slugify", () => {
  it("lowercases, hyphenates, bounds", () => {
    expect(slugify("Cheap Geo PPP pricing!")).toBe("cheap-geo-ppp-pricing");
    expect(slugify("  ---  ")).toBe("task"); // degenerate → fallback
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("readFrontmatter", () => {
  it("reads scalars incl. unknown keys; {} when absent", () => {
    const fm = readFrontmatter(README);
    expect(fm.id).toBe("cheap-geo-ppp");
    expect(fm.custom_key).toBe("kept-verbatim");
    expect(readFrontmatter("# no front matter")).toEqual({});
  });
});

describe("patchFrontmatter", () => {
  it("edits keys in place, preserving order, unknown keys, and the body byte-for-byte", () => {
    const out = patchFrontmatter(README, { status: "in-progress", follow_up_date: "2026-07-10" });
    const fm = readFrontmatter(out);
    expect(fm.status).toBe("in-progress");
    expect(fm.follow_up_date).toBe("2026-07-10"); // new key appended in-block
    expect(fm.custom_key).toBe("kept-verbatim");
    // Body unchanged, byte-for-byte.
    expect(out.slice(out.indexOf("\n## Spec"))).toBe(README.slice(README.indexOf("\n## Spec")));
    // Key ORDER preserved for edited keys.
    expect(out.indexOf("type:")).toBeLessThan(out.indexOf("status:"));
  });

  it("null deletes a key", () => {
    const out = patchFrontmatter(README, { priority: null });
    expect(readFrontmatter(out).priority).toBeUndefined();
    expect(readFrontmatter(out).id).toBe("cheap-geo-ppp");
  });

  it("creates a block above a file with no front matter", () => {
    const out = patchFrontmatter("# Heading\nbody\n", { id: "x", status: "idea" });
    expect(readFrontmatter(out)).toEqual({ id: "x", status: "idea" });
    expect(out.endsWith("# Heading\nbody\n")).toBe(true);
  });

  it("round-trips: patching a value back restores the original", () => {
    const there = patchFrontmatter(README, { status: "review" });
    const back = patchFrontmatter(there, { status: "todo" });
    expect(back).toBe(README);
  });
});

describe("appendTimeline", () => {
  it("appends at the section end, dated + attributed", () => {
    const out = appendTimeline(README, "Shipped the readout", { date: "2026-07-03", actor: "alice@x" });
    expect(out).toContain("- 2026-07-01 | Created.\n- 2026-07-03 | Shipped the readout (alice@x)\n");
  });

  it("inserts BEFORE a following section", () => {
    const withTail = README + "## Notes\ntail\n";
    const out = appendTimeline(withTail, "Entry", { date: "2026-07-03" });
    expect(out.indexOf("- 2026-07-03 | Entry")).toBeLessThan(out.indexOf("## Notes"));
    expect(out).toContain("## Notes\ntail\n");
  });

  it("creates the section when missing", () => {
    const out = appendTimeline("---\nid: x\n---\n\n## Spec\nbody\n", "First", { date: "2026-07-03" });
    expect(out).toContain("## Timeline\n- 2026-07-03 | First\n");
  });
});

describe("scaffoldReadme", () => {
  it("produces the canonical structure with defaults", () => {
    const out = scaffoldReadme({ slug: "my-task", title: "My Task", parent: "acquisition", date: "2026-07-03" });
    const fm = readFrontmatter(out);
    expect(fm).toMatchObject({ id: "my-task", title: "My Task", type: "task", status: "idea", priority: "P2", parent: "acquisition" });
    expect(out).toContain("## Spec");
    expect(out).toContain("## Current understanding");
    // The record plane is EVENTS — the scaffold deliberately carries NO Timeline
    // section (the server emits the "Created." event at create).
    expect(out).not.toContain("## Timeline");
  });
});

describe("titleSimilarity", () => {
  it("scores near-duplicates high and unrelated titles low", () => {
    expect(titleSimilarity("Cheap geo PPP pricing", "PPP pricing for cheap geos")).toBeGreaterThan(0.6);
    expect(titleSimilarity("Cheap geo PPP pricing", "Blog content cluster")).toBeLessThan(0.3);
  });
});

describe("stripTimelineSection", () => {
  it("removes the Timeline section up to the next heading, or to EOF", () => {
    const mid = "---\nid: t\n---\n\n## Spec\nx\n\n## Timeline\n- 2026-07-01 | a\n- 2026-07-02 | b\n\n## Notes\nkeep\n";
    const out = stripTimelineSection(mid);
    expect(out).toContain("## Spec");
    expect(out).toContain("## Notes\nkeep");
    expect(out).not.toContain("## Timeline");
    expect(out).not.toContain("2026-07-01");

    const tail = "## Spec\nx\n\n## Timeline\n- 2026-07-01 | a\n";
    expect(stripTimelineSection(tail)).toBe("## Spec\nx\n");
  });

  it("no Timeline section ⇒ byte-identical", () => {
    const doc = "---\nid: t\n---\n\n## Spec\nx\n";
    expect(stripTimelineSection(doc)).toBe(doc);
  });
});
