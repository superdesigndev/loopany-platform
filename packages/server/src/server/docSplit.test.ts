/**
 * Splitter fixtures shaped after the real mirror content classes: full front
 * matter + Timeline; no front matter at all; the three Timeline line formats;
 * Chinese sections; one giant unstructured body. The property under test is
 * losslessness — fields + events + doc together hold every byte of information
 * the original file did.
 */
import { describe, expect, test } from "vitest";
import { splitTaskDoc } from "./docSplit.js";

describe("splitTaskDoc", () => {
  test("full task file: derived keys subtracted, Timeline seeded, Spec stays in doc", () => {
    const src = `---
id: exp-checkout
title: Checkout experiment
status: in-progress
priority: P1
assignee: sam@x.dev
budget: $500
---

## Spec
Ship the A/B test.

## Timeline
- 2026-07-02: launched to 50%
- 2026-07-01 (alice@x.dev): approved the plan

## Current understanding
Conversion is flat so far.
`;
    const r = splitTaskDoc(src);
    // Derived keys vanish from the doc; the unknown `budget:` is carried verbatim.
    expect(r.carriedKeys).toEqual(["budget"]);
    expect(r.doc).toContain("budget: $500");
    expect(r.doc).not.toContain("status: in-progress");
    expect(r.doc).toContain("## Spec");
    expect(r.doc).toContain("## Current understanding");
    expect(r.doc).not.toContain("## Timeline");
    // Two seeded events in file order, dated, one attributed.
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toEqual({ at: "2026-07-02T00:00:00.000Z", text: "launched to 50%" });
    expect(r.events[1]).toEqual({ at: "2026-07-01T00:00:00.000Z", actor: "alice@x.dev", text: "approved the plan" });
  });

  test("invalid enum value is NOT represented by the index and is carried", () => {
    const r = splitTaskDoc(`---\nstatus: wip\ntitle: T\n---\n\n## Spec\nx\n`);
    expect(r.carriedKeys).toEqual(["status"]);
    expect(r.doc).toContain("status: wip");
    expect(r.doc).not.toContain("title: T");
  });

  test("the retired `status: review` spelling IS represented (index maps it to follow-up)", () => {
    const r = splitTaskDoc(`---\nstatus: review\n---\n\n## Spec\nx\n`);
    expect(r.carriedKeys).toEqual([]);
    expect(r.doc).not.toContain("status");
  });

  test("three Timeline line formats parse; prose lines are preserved raw", () => {
    const r = splitTaskDoc(`## Timeline
- 2026-07-03: colon form
- **2026-07-02** — bold dash form
- [2026-07-01] bracket form
follow-up next week
`);
    // The undated trailing line is the LAST entry's continuation, not a fragment.
    expect(r.events.map((e) => e.text)).toEqual(["colon form", "bold dash form", "bracket form\nfollow-up next week"]);
    expect(r.events[0]!.at).toBe("2026-07-03T00:00:00.000Z");
    expect(r.events[1]!.at).toBe("2026-07-02T00:00:00.000Z");
    expect(r.events[2]!.at).toBe("2026-07-01T00:00:00.000Z");
    expect(r.doc.trim()).toBe("");
  });

  test("Chinese sections and body text pass through the doc untouched", () => {
    const src = `---\nid: ops\ntitle: 运维手册\n---\n\n## 运维手册\n\n每天检查队列长度。\n\n## Timeline\n- 2026-06-30: 首次部署\n`;
    const r = splitTaskDoc(src);
    expect(r.doc).toContain("## 运维手册");
    expect(r.doc).toContain("每天检查队列长度。");
    expect(r.events).toEqual([{ at: "2026-06-30T00:00:00.000Z", text: "首次部署" }]);
  });

  test("no front matter, one giant unstructured body → everything is doc, zero events", () => {
    const body = `Meeting notes\n\n${"paragraph of prose. ".repeat(500)}\n`;
    const r = splitTaskDoc(body);
    expect(r.events).toEqual([]);
    expect(r.carriedKeys).toEqual([]);
    expect(r.doc).toBe(body);
  });

  test("a Timeline heading resets at the next section; later sections stay in doc", () => {
    const r = splitTaskDoc(`## Timeline\n- 2026-07-01: a\n\n## Notes\nkeep me\n`);
    expect(r.events).toHaveLength(1);
    expect(r.doc).toContain("## Notes");
    expect(r.doc).toContain("keep me");
  });

  test("empty/blank input is total", () => {
    expect(splitTaskDoc("")).toEqual({ doc: "", events: [], carriedKeys: [], representedKeys: [] });
    expect(splitTaskDoc("   \n")).toEqual({ doc: "   \n", events: [], carriedKeys: [], representedKeys: [] });
  });
});
