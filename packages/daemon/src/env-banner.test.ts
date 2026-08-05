import { describe, expect, test } from "vitest";

import { classifyEnvTarget, envBannerLine, printEnvBanner } from "./env-banner.js";

describe("classifyEnvTarget", () => {
  test("loopback hosts are DEV, with the port kept", () => {
    expect(classifyEnvTarget("http://127.0.0.1:3000")).toEqual({ label: "DEV", host: "127.0.0.1:3000" });
    expect(classifyEnvTarget("http://localhost:4319")).toEqual({ label: "DEV", host: "localhost:4319" });
    expect(classifyEnvTarget("http://[::1]:3000")).toEqual({ label: "DEV", host: "[::1]:3000" });
    // A bare host:port (no scheme) still classifies - the stored server-url file
    // and LOOPANY_SERVER_URL are both hand-set values.
    expect(classifyEnvTarget("127.0.0.1:3000")).toEqual({ label: "DEV", host: "127.0.0.1:3000" });
  });

  test("the testing deploy is TESTING", () => {
    expect(classifyEnvTarget("https://loopany-testing.fly.dev")).toEqual({ label: "TESTING", host: "loopany-testing.fly.dev" });
  });

  test("production and every unrecognized target are SILENT", () => {
    for (const url of ["https://loopany.ai", "https://www.loopany.ai", "https://loops.example.com", "", undefined, "   ", "not a url"]) {
      expect(classifyEnvTarget(url)).toBeNull();
    }
  });
});

describe("envBannerLine", () => {
  test("one line, target named, newline terminated", () => {
    expect(envBannerLine("http://127.0.0.1:3000")).toBe("» loopany · DEV · 127.0.0.1:3000\n");
    expect(envBannerLine("https://loopany-testing.fly.dev")).toBe("» loopany · TESTING · loopany-testing.fly.dev\n");
  });

  test("production prints nothing at all", () => {
    expect(envBannerLine("https://loopany.ai")).toBeNull();
  });
});

describe("printEnvBanner", () => {
  test("writes once for a dev target and never for production", () => {
    const dev: string[] = [];
    printEnvBanner("http://127.0.0.1:3000", (s) => void dev.push(s));
    expect(dev).toEqual(["» loopany · DEV · 127.0.0.1:3000\n"]);

    const prod: string[] = [];
    printEnvBanner("https://loopany.ai", (s) => void prod.push(s));
    expect(prod).toEqual([]);
  });
});
