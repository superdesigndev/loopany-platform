import { describe, expect, it } from "vitest";
import { cliVersion, versionBelow } from "../src/version.js";

describe("CLI version handshake", () => {
  it("reads the package version and compares semantic numeric components", () => {
    expect(cliVersion()).toBe("0.1.0");
    expect(versionBelow("0.1.0", "0.1.0")).toBe(false);
    expect(versionBelow("0.1.0", "0.2.0")).toBe(true);
    expect(versionBelow("1.0.0", "0.9.9")).toBe(false);
  });
});
