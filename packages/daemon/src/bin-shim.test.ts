/**
 * The `loopany` PATH shim (feedback #4). All filesystem/env touches are injected, so
 * NO test writes into the real home dir or a real bin.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { binDirCandidates, dirOnPath, ensureBinShim, existingBinShim, shimContents } from "./bin-shim.js";

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

describe("ensureBinShim", () => {
  test("writes to the first candidate and returns its path + onPath", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/opt/node", PATH: `/opt/node/bin${path.delimiter}/usr/bin` },
      homedir: () => "/home/u",
      writeShim: (dir) => void wrote.push(dir),
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/opt/node", "bin")]);
    expect(r).toEqual({ path: path.join("/opt/node", "bin", "loopany"), onPath: true });
    expect(out.join("")).toBe(""); // on PATH → no guidance
  });

  test("falls back to ~/.local/bin when the global bin is unwritable (EACCES), with PATH guidance", () => {
    const wrote: string[] = [];
    const out: string[] = [];
    const r = ensureBinShim({
      env: { npm_config_prefix: "/usr/local", PATH: "/usr/bin" },
      homedir: () => "/home/u",
      writeShim: (dir) => {
        if (dir === path.join("/usr/local", "bin")) throw new Error("EACCES");
        wrote.push(dir);
      },
      out: (s) => out.push(s),
    });
    expect(wrote).toEqual([path.join("/home/u", ".local", "bin")]);
    expect(r.path).toBe(path.join("/home/u", ".local", "bin", "loopany"));
    expect(r.onPath).toBe(false);
    expect(out.join("")).toContain("add it to your PATH");
    expect(out.join("")).toContain(path.join("/home/u", ".local", "bin"));
  });

  test("every candidate failing → best-effort null + an announced line, never throws", () => {
    const out: string[] = [];
    const r = ensureBinShim({
      env: {},
      homedir: () => "/home/u",
      writeShim: () => {
        throw new Error("EROFS");
      },
      out: (s) => out.push(s),
    });
    expect(r).toEqual({ path: null, onPath: false });
    expect(out.join("")).toContain("could not write");
  });
});

describe("existingBinShim", () => {
  test("returns the first candidate that already has a `loopany`, else null", () => {
    const found = path.join("/home/u", ".local", "bin", "loopany");
    expect(existingBinShim({ env: {}, homedir: () => "/home/u", exists: (p) => p === found })).toBe(found);
    expect(existingBinShim({ env: {}, homedir: () => "/home/u", exists: () => false })).toBeNull();
  });
});
