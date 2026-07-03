/**
 * version — robust package-version resolution (works from both src/ and dist/
 * via `../package.json`) and the best-effort running-version file that
 * `loopany update` reads. The fs-touching tests relocate ~/.loopany via
 * LOOPANY_HOME and re-import the module so VERSION_FILE (computed at load)
 * points at a temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { daemonVersion } from "./version.js";

describe("daemonVersion", () => {
  test("resolves this package's real version", () => {
    // ../package.json from src/ (this test's dir) is the daemon package.json.
    const v = daemonVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("base override: reads version from a package.json one dir up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-ver-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
      expect(daemonVersion(path.join(dir, "sub"))).toBe("1.2.3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing/garbage package.json → undefined (never throws)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-ver-"));
    try {
      expect(daemonVersion(path.join(dir, "sub"))).toBeUndefined(); // no package.json
      fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
      expect(daemonVersion(path.join(dir, "sub"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("running-version file", () => {
  const prevHome = process.env.LOOPANY_HOME;
  let home: string | undefined;

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LOOPANY_HOME;
    else process.env.LOOPANY_HOME = prevHome;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
    vi.resetModules();
  });

  test("write then read round-trips; absent file → undefined", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-verfile-"));
    vi.resetModules();
    process.env.LOOPANY_HOME = home;
    const mod = await import("./version.js");

    expect(mod.readRunningVersion()).toBeUndefined();
    mod.writeRunningVersion("0.8.0");
    expect(mod.readRunningVersion()).toBe("0.8.0");

    // A falsy version is a no-op (nothing to record). Passing `undefined`
    // re-triggers the `= daemonVersion()` default parameter, so use `""` to
    // exercise the `if (!version) return` guard without coupling to this
    // package's real version.
    mod.writeRunningVersion("");
    expect(mod.readRunningVersion()).toBe("0.8.0");
  });
});
