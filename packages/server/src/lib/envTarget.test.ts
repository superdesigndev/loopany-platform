import { describe, expect, test } from "vitest";

import { classifyEnvTarget, serverBaseUrl, viaHostSuffix } from "./envTarget.js";

describe("classifyEnvTarget", () => {
  test("loopback hosts are DEV, with the port kept", () => {
    expect(classifyEnvTarget("http://127.0.0.1:3000")).toEqual({ label: "DEV", host: "127.0.0.1:3000" });
    expect(classifyEnvTarget("http://localhost:4319")).toEqual({ label: "DEV", host: "localhost:4319" });
    expect(classifyEnvTarget("127.0.0.1:4319")).toEqual({ label: "DEV", host: "127.0.0.1:4319" });
  });

  test("the testing deploy is TESTING", () => {
    expect(classifyEnvTarget("https://loopany-testing.fly.dev")).toEqual({ label: "TESTING", host: "loopany-testing.fly.dev" });
  });

  test("production and every unrecognized target are SILENT", () => {
    for (const url of ["https://loopany.ai", "https://www.loopany.ai", "https://loops.example.com", "", undefined, "not a url"]) {
      expect(classifyEnvTarget(url)).toBeNull();
    }
  });
});

test("serverBaseUrl mirrors auth.ts: LOOPANY_BASE_URL, defaulting to local dev", () => {
  expect(serverBaseUrl({ LOOPANY_BASE_URL: "https://loopany.ai" } as NodeJS.ProcessEnv)).toBe("https://loopany.ai");
  expect(serverBaseUrl({} as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:3000");
  // Unset base URL means a local dev server, so the fallback names the port this
  // process actually listens on (the isolated-stack recipe sets LOOPANY_PORT).
  expect(serverBaseUrl({ LOOPANY_PORT: "4319" } as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:4319");
  expect(serverBaseUrl({ LOOPANY_BASE_URL: "https://loopany.ai", LOOPANY_PORT: "4319" } as NodeJS.ProcessEnv)).toBe("https://loopany.ai");
});

test("viaHostSuffix is EMPTY on production and names the host on a developer stack", () => {
  expect(viaHostSuffix({ LOOPANY_BASE_URL: "https://loopany.ai" } as NodeJS.ProcessEnv)).toBe("");
  expect(viaHostSuffix({ LOOPANY_BASE_URL: "http://127.0.0.1:4319" } as NodeJS.ProcessEnv)).toBe(" · via 127.0.0.1:4319");
  expect(viaHostSuffix({ LOOPANY_BASE_URL: "https://loopany-testing.fly.dev" } as NodeJS.ProcessEnv)).toBe(" · via loopany-testing.fly.dev");
});
