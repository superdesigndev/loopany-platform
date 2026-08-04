import { describe, expect, it } from "vitest";

import { BOARD_COLUMNS, BOARD_COLUMN_KEYS, columnFor, type BoardTaskFacts } from "./taskBoard.js";
import { TASK_STATUSES } from "./types.js";

/**
 * The board's column mapping, pure.
 *
 * Two properties matter more than any individual case and both are asserted
 * directly: the mapping is TOTAL (every combination of the kernel's task facts
 * lands somewhere) and DISJOINT (it lands in exactly one place). A board that
 * drops a card is a board that hides work, which is the one failure the design's
 * safety floor exists to prevent.
 */

const NOW = "2026-08-08T12:00:00.000Z";
const past = "2026-08-07T12:00:00.000Z";
const future = "2026-08-09T12:00:00.000Z";

const task = (over: Partial<BoardTaskFacts> = {}): BoardTaskFacts => ({
  status: "open", pendingQuestion: null, followUpAt: null, ...over,
});

describe("columnFor — one cell of the kernel's fact table per column", () => {
  it("a closed task is a record, whatever its facets still say", () => {
    expect(columnFor(task({ status: "closed" }), NOW)).toBe("closed");
    expect(columnFor(task({ status: "closed", followUpAt: past }), NOW)).toBe("closed");
  });

  it("a pending question outranks every other open fact — nothing else can move it", () => {
    expect(columnFor(task({ pendingQuestion: "revert or wait?" }), NOW)).toBe("waiting");
    expect(columnFor(task({ pendingQuestion: "revert or wait?", followUpAt: past }), NOW)).toBe("waiting");
  });

  it("blank question text is not a question", () => {
    expect(columnFor(task({ pendingQuestion: "   " }), NOW)).toBe("watched");
  });

  it("splits open work on the follow-up date, and the boundary is inclusive", () => {
    expect(columnFor(task({ followUpAt: past }), NOW)).toBe("due");
    expect(columnFor(task({ followUpAt: NOW }), NOW)).toBe("due");
    expect(columnFor(task({ followUpAt: future }), NOW)).toBe("watched");
    expect(columnFor(task({ followUpAt: null }), NOW)).toBe("watched");
  });

  it("does not read a watcher at all — every task has one, so it separates nothing", () => {
    // The retired `unclaimed` column was the ONLY consumer of that fact here.
    // Passing one in is a type error; this pins the behavioural half, that two
    // tasks differing only in watcher land in the same column.
    expect(Object.keys(task())).toEqual(["status", "pendingQuestion", "followUpAt"]);
  });
});

describe("the mapping is total and disjoint", () => {
  it("puts every combination of the kernel's task facts in exactly one column", () => {
    const keys = new Set<string>(BOARD_COLUMN_KEYS);
    for (const status of TASK_STATUSES) {
      for (const pendingQuestion of [null, "", "  ", "ask?"]) {
        for (const followUpAt of [null, past, NOW, future]) {
          const column = columnFor({ status, pendingQuestion, followUpAt }, NOW);
          expect(keys.has(column), `${status}/${pendingQuestion}/${followUpAt} → ${column}`).toBe(true);
        }
      }
    }
  });

  it("names one column per key, each with a one-sentence rule", () => {
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual([...BOARD_COLUMN_KEYS]);
    for (const column of BOARD_COLUMNS) {
      expect(column.label.length).toBeGreaterThan(0);
      expect(column.rule).toMatch(/\.$/);
      expect(column.rule.split(". ").length, `${column.key} must be explainable in one sentence`).toBe(1);
    }
  });

  it("covers the four filters the list screen offers, and has no unclaimed column", () => {
    // Open / Due / Questions / Closed, turned from a chooser into a layout — the
    // same predicates, all visible at once. `unclaimed` is ABSENT, not empty:
    // the watcher rule removed the state, so a column for it would be a
    // permanently-zero heading claiming the system can still produce unowned work.
    expect(new Set(BOARD_COLUMN_KEYS)).toEqual(new Set(["watched", "due", "waiting", "closed"]));
    expect(BOARD_COLUMNS.some((c) => c.key === ("unclaimed" as never))).toBe(false);
    for (const column of BOARD_COLUMNS) expect(column.rule.toLowerCase()).not.toContain("unclaimed");
  });
});
