/**
 * cronText — the ONE cron humaniser (moved down from server lib/format.ts,
 * which re-exports it). Common shapes humanize; anything else falls back to
 * the raw expression, never a wrong guess.
 */
import { describe, expect, it } from "vitest";
import { cronText } from "../src/format.js";

describe("cronText", () => {
  it("humanizes the common shapes", () => {
    expect(cronText("0 7 * * *")).toBe("daily 07:00");
    expect(cronText("30 9 * * 1")).toBe("Mon 09:30");
    expect(cronText("0 7 * * 7")).toBe("Sun 07:00"); // 7 == Sunday too
    expect(cronText("*/15 * * * *")).toBe("every 15m");
    expect(cronText("0 */3 * * *")).toBe("every 3h");
    expect(cronText("7 * * * *")).toBe("hourly :07");
  });

  it("names day-of-week sets", () => {
    expect(cronText("0 9 * * 1,2,3,4,5")).toBe("weekdays 09:00");
    expect(cronText("0 9 * * 0,6")).toBe("weekends 09:00");
    expect(cronText("0 9 * * 1,4")).toBe("Mon/Thu 09:00");
    expect(cronText("0 9 * * 0,7")).toBe("Sun 09:00"); // 0 and 7 are one day
  });

  it("falls back to the raw expression for uncommon shapes", () => {
    expect(cronText("0 7 1 * *")).toBe("0 7 1 * *"); // day-of-month pinned
    expect(cronText("0 9 * * 1-5")).toBe("0 9 * * 1-5"); // range, not a comma list
    expect(cronText("not a cron")).toBe("not a cron");
    expect(cronText("")).toBe("");
  });
});
