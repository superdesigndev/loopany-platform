/**
 * The `loopany` PATH shim (feedback #4). All filesystem/env touches are injected, so
 * NO test writes into the real home dir or a real bin.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { binDirCandidates, dirOnPath, ensureBinShim, existingBinShim, isEphemeralEntry, resolveDurableCommand, shimContents } from "./bin-shim.js";

describe("binDirCandidates", () => {
  test("prefers the npm global bin (npm_config_prefix) then ~/.local/bin", () => {
    expect(binDirCandidates({ npm_config_prefix: "/usr/local" }, "/home/u")).toEqual([
      path.join("/usr/local", "bin"),
      path.join("/home/u", ".local", "bin"),
    ]);
  });
  test("without a global prefix, only ~/.local/bin", () => {
    expect(binDirCandidates({}, "/home/u")).toEqual([path.join("/home/u", ".local", "bin")]);
  });
});

describe("dirOnPath", () => {
  test("exact normalized segment match", () => {
    expect(dirOnPath("/home/u/.local/bin", `/usr/bin${path.delimiter}/home/u/.local/bin`)).toBe(true);
    expect(dirOnPath("/home/u/.local/bin/", `/usr/bin${path.delimiter}/home/u/.local/bin`)).toBe(true);
    expect(dirOnPath("/home/u/.local/bin", "/usr/bin")).toBe(false);
    expect(dirOnPath("/home/u/.local/bin", undefined)).toBe(false);
  });
});

describe("shimContents", () => {
  test("is a /bin/sh re-exec wrapper replaying the launcher (like callback-bin)", () => {
    const s = shimContents("/usr/bin/node", ["--enable-source-maps"], "/pkg/dist/cli.js");
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s).toContain("exec '/usr/bin/node' '--enable-source-maps' '/pkg/dist/cli.js' \"$@\"");
  });
});

describe("isEphemeralEntry", () => {
  test("flags npx / npm cache paths, not durable installs", () => {
    expect(isEphemeralEntry("/home/u/.npm/_npx/abc123/node_modules/@crewlet/loopany/dist/cli.js")).toBe(true);
    expect(isEphemeralEntry("/home/u/.npm/_cacache/content-v2/x")).toBe(true);
    expect(isEphemeralEntry("C:\\Users\\u\\AppData\\npm-cache\\_npx\\abc\\cli.js")).toBe(true);
    expect(isEphemeralEntry("/usr/local/lib/node_modules/@crewlet/loopany/dist/cli.js")).toBe(false);
    expect(isEphemeralEntry("/home/u/.local/bin/loopany")).toBe(false);
    expect(isEphemeralEntry("")).toBe(false);
  });
});

describe("ensureBinShim", () => {
  test("writes to the first candidate and returns its path + onPath + written", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: `/opt/node/bin${path.delimiter}/usr/bin` },
      homedir: () => "/home/u",
      entry: () => "/opt/node/lib/node_modules/@crewlet/loopany/dist/cli.js",
      readShim: () => null,
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/opt/node", "bin")]);
    expect(r).toEqual({ path: path.join("/opt/node", "bin", "loopany"), onPath: true, written: true });
    expect(out.join("")).toBe(""); // on PATH → no guidance
  });

  test("falls back to ~/.local/bin when the global bin is unwritable (EACCES), with PATH guidance", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/usr/local", PATH: "/usr/bin" },
      homedir: () => "/home/u",
      entry: () => "/usr/local/lib/node_modules/@crewlet/loopany/dist/cli.js",
      readShim: () => null,
      writeShim: (dir) => {
        if (dir === path.join("/usr/local", "bin")) throw new Error("EACCES");
        wrote.push(dir);
      },
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/home/u", ".local", "bin")]);
    expect(r.path).toBe(path.join("/home/u", ".local", "bin", "loopany"));
    expect(r.onPath).toBe(false);
    expect(r.written).toBe(true);
    expect(out.join("")).toContain("add it to your PATH");
    expect(out.join("")).toContain(path.join("/home/u", ".local", "bin"));
  });

  test("every candidate failing → best-effort null + an announced line, never throws", () => {
    const out: string[] = [];
    const r = ensureBinShim({
      env: {},
      homedir: () => "/home/u",
      entry: () => "/usr/local/lib/node_modules/@crewlet/loopany/dist/cli.js",
      readShim: () => null,
      writeShim: () => {
        throw new Error("EROFS");
      },
      out: (s) => out.push(s),
    });
    expect(r).toEqual({ path: null, onPath: false, written: false });
    expect(out.join("")).toContain("could not write");
  });

  test("ephemeral (npx-cache) entry → skips writing, prints global-install guidance", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: "/opt/node/bin" },
      homedir: () => "/home/u",
      entry: () => "/home/u/.npm/_npx/abc123/node_modules/@crewlet/loopany/dist/cli.js",
      readShim: () => null,
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([]); // never wrote
    expect(r).toEqual({ path: null, onPath: false, written: false });
    expect(out.join("")).toContain("npx cache");
    expect(out.join("")).toContain("npm i -g @crewlet/loopany");
  });

  test("refuses to overwrite a FOREIGN `loopany`, falling through to the next candidate", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const globalBin = path.join("/opt/node", "bin", "loopany");
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: `/opt/node/bin${path.delimiter}/home/u/.local/bin` },
      homedir: () => "/home/u",
      entry: () => "/opt/node/lib/node_modules/@crewlet/loopany/dist/cli.js",
      // A real installed binary at the global bin — not our shim.
      readShim: (p) => (p === globalBin ? "#!/usr/bin/env node\nconsole.log('real bin')" : null),
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/home/u", ".local", "bin")]); // skipped the foreign one
    expect(r.path).toBe(path.join("/home/u", ".local", "bin", "loopany"));
    expect(r.written).toBe(true);
  });

  test("idempotently refreshes our OWN prior shim (marker match)", () => {
    const wrote: string[] = [];
    const globalBin = path.join("/opt/node", "bin", "loopany");
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: "/opt/node/bin" },
      homedir: () => "/home/u",
      entry: () => "/opt/node/lib/node_modules/@crewlet/loopany/dist/cli.js",
      readShim: (p) => (p === globalBin ? "#!/bin/sh\nexec '/usr/bin/node' '/old/cli.js' \"$@\"\n" : null),
      writeShim: (dir) => void wrote.push(dir),
    });
    expect(wrote).toEqual([path.join("/opt/node", "bin")]); // overwrote our own shim
    expect(r).toEqual({ path: globalBin, onPath: true, written: true });
  });
});

describe("existingBinShim", () => {
  test("returns the first candidate that already has a `loopany`, else null", () => {
    const found = path.join("/home/u", ".local", "bin", "loopany");
    expect(existingBinShim({ env: {}, homedir: () => "/home/u", exists: (p) => p === found })).toBe(found);
    expect(existingBinShim({ env: {}, homedir: () => "/home/u", exists: () => false })).toBeNull();
  });
});

describe("resolveDurableCommand", () => {
  test("our shim in a candidate dir → that absolute path", () => {
    const shim = path.join("/home/u", ".local", "bin", "loopany");
    expect(resolveDurableCommand({ env: {}, homedir: () => "/home/u", exists: (p) => p === shim })).toBe(shim);
  });

  test("no candidate shim but a `loopany` on PATH → that absolute path", () => {
    const onPath = path.join("/usr/local/bin", "loopany");
    expect(
      resolveDurableCommand({ env: { PATH: `/usr/bin${path.delimiter}/usr/local/bin` }, homedir: () => "/home/u", exists: (p) => p === onPath }),
    ).toBe(onPath);
  });

  test("an EPHEMERAL npx PATH entry is NOT durable → null (F6 hook-gating parity)", () => {
    // `npx @crewlet/loopany …` prepends its throwaway `…/_npx/…/.bin` onto PATH; a
    // `loopany` there must NOT count as durable, or the hook installs against a bin that
    // vanishes once the cache is pruned (the exact F6 disagreement: shim skipped, hook not).
    const npxBin = "/home/u/.npm/_npx/abc123/node_modules/.bin";
    const ephemeral = path.join(npxBin, "loopany");
    expect(
      resolveDurableCommand({ env: { PATH: npxBin }, homedir: () => "/home/u", exists: (p) => p === ephemeral }),
    ).toBeNull();
  });

  test("nothing durable (npx-without-global) → null", () => {
    expect(resolveDurableCommand({ env: { PATH: "/usr/bin" }, homedir: () => "/home/u", exists: () => false })).toBeNull();
    expect(resolveDurableCommand({ env: {}, homedir: () => "/home/u", exists: () => false })).toBeNull();
  });
});
