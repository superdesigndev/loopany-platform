import { expect, test } from "vitest";

import { safeRelPath } from "./artifacts.js";

// Pure path-safety unit tests (no DB). The NUL case is the pg-hardening one:
// artifact_files.path is a Postgres text column, which rejects U+0000 - a
// hostile manifest path carrying one must be dropped at validation, not allowed
// through to 500 the whole sync on the row write. (No real filesystem can
// produce a NUL filename, so rejecting is always correct.)
test("safeRelPath rejects a NUL-carrying path", () => {
  expect(safeRelPath("a\u0000b.md")).toBeNull();
  expect(safeRelPath("dir/\u0000/file.md")).toBeNull();
});

test("safeRelPath keeps its existing normalize/reject contract", () => {
  expect(safeRelPath("notes/report.md")).toBe("notes/report.md");
  expect(safeRelPath("./notes//report.md")).toBe("notes/report.md");
  expect(safeRelPath("dir\\win\\file.md")).toBe("dir/win/file.md");
  expect(safeRelPath("/etc/passwd")).toBeNull(); // absolute
  expect(safeRelPath("../escape.md")).toBeNull(); // traversal
  expect(safeRelPath("   ")).toBeNull(); // empty
});
