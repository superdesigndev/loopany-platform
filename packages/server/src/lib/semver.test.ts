import { describe, expect, test } from "vitest";

import { isOutdated } from "./semver.js";

describe("isOutdated", () => {
  test("older across each version position → true", () => {
    expect(isOutdated("0.8.0", "0.9.0")).toBe(true);
    expect(isOutdated("0.8.9", "0.9.0")).toBe(true);
    expect(isOutdated("1.0.0", "2.0.0")).toBe(true);
    expect(isOutdated("1.2.3", "1.2.4")).toBe(true);
  });

  test("equal or newer → false", () => {
    expect(isOutdated("0.9.0", "0.9.0")).toBe(false);
    expect(isOutdated("0.10.0", "0.9.0")).toBe(false); // 10 > 9 numerically, not lexically
    expect(isOutdated("2.0.0", "1.9.9")).toBe(false);
  });

  test("unknown either side → false (hint is opt-in)", () => {
    expect(isOutdated(null, "0.9.0")).toBe(false);
    expect(isOutdated("0.8.0", null)).toBe(false);
    expect(isOutdated(undefined, undefined)).toBe(false);
    expect(isOutdated("", "0.9.0")).toBe(false);
  });

  test("garbage version strings → false, never throws", () => {
    expect(isOutdated("not-a-version", "0.9.0")).toBe(false);
    expect(isOutdated("0.9", "0.9.0")).toBe(false); // needs full x.y.z core
  });

  test("leading v and pre-release handling", () => {
    expect(isOutdated("v0.8.0", "v0.9.0")).toBe(true);
    // Same numeric core: a pre-release is behind its release.
    expect(isOutdated("0.9.0-rc.1", "0.9.0")).toBe(true);
    expect(isOutdated("0.9.0", "0.9.0-rc.1")).toBe(false);
  });
});
