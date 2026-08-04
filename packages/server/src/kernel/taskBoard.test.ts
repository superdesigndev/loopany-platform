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
  status: "open", pendingQuestion: null, watcher: null, followUpAt: null, ...over,
});

describe("columnFor — one cell of the kernel's fact table per column", () => {
  it("a closed task is a record, whatever its facets still say", () => {
    expect(columnFor(task({ status: "closed" }), NOW)).toBe("closed");
    expect(columnFor(task({ status: "closed", watcher: "loop-a", followUpAt: past }), NOW)).toBe("closed");
  });

  it("a pending question outranks every other open fact — nothing else can move it", () => {
    expect(columnFor(task({ pendingQuestion: "revert or wait?" }), NOW)).toBe("waiting");
    expect(columnFor(task({ pendingQuestion: "revert or wait?", watcher: "loop-a", followUpAt: past }), NOW)).toBe("waiting");
  });

  it("blank question text is not a question", () => {
    expect(columnFor(task({ pendingQuestion: "   ", watcher: "loop-a" }), NOW)).toBe("watched");
  });

  it("no watcher is the unclaimed pool, due or not", () => {
    expect(columnFor(task({ watcher: null }), NOW)).toBe("unclaimed");
    // Due AND unwatched stays in the pool: a date on a task no loop watches is
    // nobody's alarm. The safety-floor counter above the board is what keeps
    // that combination visible.
    expect(columnFor(task({ watcher: null, followUpAt: past }), NOW)).toBe("unclaimed");
  });

  it("watched splits on the follow-up date, and the boundary is inclusive", () => {
    expect(columnFor(task({ watcher: "loop-a", followUpAt: past }), NOW)).toBe("due");
    expect(columnFor(task({ watcher: "loop-a", followUpAt: NOW }), NOW)).toBe("due");
    expect(columnFor(task({ watcher: "loop-a", followUpAt: future }), NOW)).toBe("watched");
    expect(columnFor(task({ watcher: "loop-a", followUpAt: null }), NOW)).toBe("watched");
  });
});

describe("the mapping is total and disjoint", () => {
  it("puts every combination of the kernel's task facts in exactly one column", () => {
    const keys = new Set<string>(BOARD_COLUMN_KEYS);
    for (const status of TASK_STATUSES) {
      for (const pendingQuestion of [null, "", "  ", "ask?"]) {
        for (const watcher of [null, "loop-a"]) {
          for (const followUpAt of [null, past, NOW, future]) {
            const column = columnFor({ status, pendingQuestion, watcher, followUpAt }, NOW);
            expect(keys.has(column), `${status}/${pendingQuestion}/${watcher}/${followUpAt} → ${column}`).toBe(true);
          }
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

  it("covers the five filters the list screen used to offer", () => {
    // Open / Due / Questions / Unclaimed / Closed, turned from a chooser into a
    // layout — the same predicates, all visible at once.
    expect(new Set(BOARD_COLUMN_KEYS)).toEqual(new Set(["watched", "due", "waiting", "unclaimed", "closed"]));
  });
});
