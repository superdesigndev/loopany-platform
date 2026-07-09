/**
 * Workdir-jail helpers — the local-always-wins semantics: server-sent roots may
 * only NARROW the daemon's ADSCAILE_ROOTS jail, never widen it.
 */
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ADSCAILE_DIR } from "./config.js";
import { effectiveRoots, isScratchDir, isWithinRoots } from "./roots.js";

describe("isWithinRoots", () => {
  test("at/under a root matches; siblings and name-prefixes don't", () => {
    expect(isWithinRoots("/home/u/projects", ["/home/u/projects"])).toBe(true);
    expect(isWithinRoots("/home/u/projects/loop", ["/home/u/projects"])).toBe(true);
    expect(isWithinRoots("/home/u/projects-evil", ["/home/u/projects"])).toBe(false);
    expect(isWithinRoots("/home/u/.ssh", ["/home/u/projects"])).toBe(false);
  });

  test("tilde roots expand to the home dir", () => {
    expect(isWithinRoots(path.join(os.homedir(), "projects/x"), ["~/projects"])).toBe(true);
  });

  test("unresolved `..` segments cannot escape the jail (lexical-prefix bypass)", () => {
    // Lexically under the root, but the OS resolves it OUTSIDE — must be rejected.
    expect(isWithinRoots("/home/u/projects/../../../etc", ["/home/u/projects"])).toBe(false);
    expect(isWithinRoots("/home/u/projects/../.ssh", ["/home/u/projects"])).toBe(false);
    // `..` that stays inside the root is fine.
    expect(isWithinRoots("/home/u/projects/a/../b", ["/home/u/projects"])).toBe(true);
  });
});

describe("effectiveRoots — the local jail always applies", () => {
  test("no local roots → server roots as-is (unchanged, fully-open default)", () => {
    expect(effectiveRoots([], ["/srv/loops"])).toEqual(["/srv/loops"]);
    expect(effectiveRoots([], undefined)).toEqual([]);
  });

  test("local roots with no server roots → the local jail", () => {
    expect(effectiveRoots(["/home/u/projects"], undefined)).toEqual(["/home/u/projects"]);
    expect(effectiveRoots(["/home/u/projects"], [])).toEqual(["/home/u/projects"]);
  });

  test("server roots inside a local root NARROW the jail", () => {
    expect(effectiveRoots(["/home/u/projects"], ["/home/u/projects/loops"])).toEqual(["/home/u/projects/loops"]);
  });

  test("server roots outside the local jail are IGNORED (a hostile server can't widen)", () => {
    expect(effectiveRoots(["/home/u/projects"], ["/home/u/.ssh"])).toEqual(["/home/u/projects"]);
    expect(effectiveRoots(["/home/u/projects"], ["/home/u/projects/ok", "/etc"])).toEqual(["/home/u/projects/ok"]);
  });

  test("never returns empty when a jail is intended (empty means 'no jail' downstream)", () => {
    expect(effectiveRoots(["/a"], ["/b"]).length).toBeGreaterThan(0);
  });
});

describe("isScratchDir", () => {
  test("the daemon-owned scratch parent is recognized; anything else isn't", () => {
    expect(isScratchDir(path.join(ADSCAILE_DIR, "work", "loop-1"))).toBe(true);
    expect(isScratchDir(path.join(ADSCAILE_DIR, "work"))).toBe(true);
    expect(isScratchDir("/tmp/elsewhere")).toBe(false);
  });

  test("unresolved `..` under the scratch prefix does not count as scratch", () => {
    // Raw string (path.join would normalize it away) — lexically prefixed by
    // the scratch dir but resolving elsewhere.
    expect(isScratchDir(`${ADSCAILE_DIR}/work/../../../etc`)).toBe(false);
  });
});
