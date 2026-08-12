import { describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/time.js";

describe("formatLocalTime", () => {
  it("renders in the machine timezone as YYYY-MM-DD HH:mm", () => {
    const iso = "2026-08-12T04:21:42.872Z";
    const date = new Date(iso);
    const pad = (part: number): string => String(part).padStart(2, "0");
    expect(formatLocalTime(iso)).toBe(
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    );
  });

  it("passes invalid input through instead of hiding corrupt data", () => {
    expect(formatLocalTime("not-a-time")).toBe("not-a-time");
  });
});
