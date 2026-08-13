import { describe, expect, it } from "vitest";
import { formatOpen, isSettingsSection, parseOpen, viewFromPathname } from "./routing";

describe("kernel routing", () => {
  it("parses ?open into a selection", () => {
    expect(parseOpen("task:task-1")).toEqual({ kind: "task", id: "task-1" });
    expect(parseOpen("member:usr_1")).toEqual({ kind: "member", id: "usr_1" });
    // Ids are opaque: only the FIRST colon separates the kind.
    expect(parseOpen("doc:notes:2026")).toEqual({ kind: "doc", id: "notes:2026" });
    expect(parseOpen("run:run-1", "e2")).toEqual({ kind: "run", id: "run-1", eventKey: "e2" });
  });

  it("ignores anything it cannot resolve rather than failing the route", () => {
    for (const value of [undefined, "", "task", "task:", ":task-1", "loop:l1", 42, null]) {
      expect(parseOpen(value), String(value)).toBeNull();
    }
    expect(parseOpen("task:task-1", 7)).toEqual({ kind: "task", id: "task-1" });
  });

  it("round-trips a selection through the search params", () => {
    const selection = { kind: "run" as const, id: "run-1", eventKey: "e2" };
    const search = formatOpen(selection);
    expect(search).toEqual({ open: "run:run-1", row: "e2" });
    expect(parseOpen(search.open, search.row)).toEqual(selection);
    expect(formatOpen({ kind: "task", id: "t1" }).row).toBeUndefined();
  });

  it("reads the active view from the path", () => {
    expect(viewFromPathname("/t/acme/kernel/tasks")).toBe("tasks");
    expect(viewFromPathname("/t/acme/kernel/timeline/")).toBe("timeline");
    expect(viewFromPathname("/t/acme/kernel/settings/machines")).toBe("settings");
    // Bare + unknown both fall back to the default rather than blanking the rail.
    expect(viewFromPathname("/t/acme/kernel")).toBe("inbox");
    expect(viewFromPathname("/t/acme/kernel/nope")).toBe("inbox");
    // A team whose slug is "kernel" must not shift the segment window.
    expect(viewFromPathname("/t/kernel/kernel/documents")).toBe("documents");
  });

  it("validates a settings section", () => {
    expect(isSettingsSection("machines")).toBe(true);
    expect(isSettingsSection("billing")).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
  });
});
