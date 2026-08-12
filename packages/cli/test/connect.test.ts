/**
 * GLOBAL remote binding (`connect`) - the file lifecycle and, load-bearing, the
 * RESOLUTION PRECEDENCE: env > cwd workspace > global binding, with `--remote`
 * forcing the global from anywhere. The workspace-beats-global rule is the
 * no-silent-redirect guarantee - a forgotten binding must never send a local
 * command to a server.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGlobalConnect, connectPath, readGlobalConnect, redactToken, writeGlobalConnect } from "../src/connect.js";
import { selectBackend } from "../src/backend.js";
import { run } from "../src/cli.js";
import type { SyncTransport } from "../src/remote.js";

let home: string;
let cwd: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lk-connect-home-"));
  cwd = mkdtempSync(join(tmpdir(), "lk-connect-cwd-"));
  env = { LOOPANY_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** A transport that records requests and answers an empty read. */
function fakeTransport(): { transport: SyncTransport; calls: Array<{ url: string; token: string }> } {
  const calls: Array<{ url: string; token: string }> = [];
  const transport: SyncTransport = (url, token) => {
    calls.push({ url, token });
    return { status: 200, response: { ok: true, snapshot: { objects: {}, triggers: [], runs: [] }, events: {} } };
  };
  return { transport, calls };
}

describe("connect file lifecycle", () => {
  it("writes 0600, reads back, redacts, clears", () => {
    const path = writeGlobalConnect(env, { backend: "https://x.example/", token: "dk_secret_1234" });
    expect(path).toBe(connectPath(env));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Trailing slash normalized on write AND read.
    expect(readGlobalConnect(env)).toEqual({ backend: "https://x.example", token: "dk_secret_1234" });
    expect(redactToken("dk_secret_1234")).toBe("dk_secr…1234");
    expect(clearGlobalConnect(env)).toBe(true);
    expect(readGlobalConnect(env)).toBeNull();
    expect(clearGlobalConnect(env)).toBe(false);
  });

  it("a malformed or non-http binding reads as null, never throws", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(connectPath(env), "not json");
    expect(readGlobalConnect(env)).toBeNull();
    writeFileSync(connectPath(env), JSON.stringify({ backend: "ftp://x", token: "t" }));
    expect(readGlobalConnect(env)).toBeNull();
  });
});

describe("selectBackend precedence", () => {
  it("global binding is the NO-WORKSPACE fallback", () => {
    const { transport, calls } = fakeTransport();
    writeGlobalConnect(env, { backend: "https://fly.example", token: "dk_g" });
    const backend = selectBackend(cwd, env, transport);
    expect(backend.kind).toBe("remote");
    backend.snapshot();
    expect(calls[0]).toEqual({ url: "https://fly.example/api/kernel/cli", token: "dk_g" });
  });

  it("a cwd WORKSPACE shadows the global binding (no silent redirect)", () => {
    writeGlobalConnect(env, { backend: "https://fly.example", token: "dk_g" });
    mkdirSync(join(cwd, ".loopany"), { recursive: true });
    writeFileSync(join(cwd, ".loopany", "config.json"), JSON.stringify({ backend: "local" }));
    expect(selectBackend(cwd, env, fakeTransport().transport).kind).toBe("local");
  });

  it("--remote forces the global binding straight through a cwd workspace", () => {
    const { transport, calls } = fakeTransport();
    writeGlobalConnect(env, { backend: "https://fly.example", token: "dk_g" });
    mkdirSync(join(cwd, ".loopany"), { recursive: true });
    writeFileSync(join(cwd, ".loopany", "config.json"), JSON.stringify({ backend: "local" }));
    const backend = selectBackend(cwd, env, transport, { remote: true });
    expect(backend.kind).toBe("remote");
    backend.snapshot();
    expect(calls[0]!.token).toBe("dk_g");
  });

  it("--remote with no binding is a loud NO_CREDENTIAL (the hint names the connect verb)", () => {
    let thrown: unknown;
    try {
      selectBackend(cwd, env, fakeTransport().transport, { remote: true });
    } catch (e) {
      thrown = e;
    }
    expect(String((thrown as Error).message)).toContain("global binding");
    expect(String((thrown as { hint?: string }).hint)).toContain("connect <url> --token");
  });

  it("env LOOPANY_KERNEL_BACKEND still beats everything", () => {
    const { transport, calls } = fakeTransport();
    writeGlobalConnect(env, { backend: "https://fly.example", token: "dk_g" });
    const backend = selectBackend(
      cwd,
      { ...env, LOOPANY_KERNEL_BACKEND: "https://env.example", LOOPANY_KERNEL_TOKEN: "rk_run" },
      transport,
    );
    backend.snapshot();
    expect(calls[0]).toEqual({ url: "https://env.example/api/kernel/cli", token: "rk_run" });
  });

  it("no workspace + no binding keeps the plain NO_WORKSPACE error", () => {
    expect(() => selectBackend(cwd, env, fakeTransport().transport)).toThrowError(/workspace|\.loopany|init/i);
  });
});

describe("the connect verb", () => {
  it("verifies the pair with one read, persists, shows redacted, clears", () => {
    const { transport, calls } = fakeTransport();
    const deps = { cwd, env, transport, now: "2026-08-12T00:00:00.000Z" };
    const set = run(["connect", "https://fly.example", "--token", "dk_secret_1234"], deps as never);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("connected: https://fly.example");
    expect(calls).toHaveLength(1); // the verification read
    const show = run(["connect"], deps as never);
    expect(show.stdout).toContain("https://fly.example");
    expect(show.stdout).toContain("dk_secr…1234");
    expect(show.stdout).not.toContain("dk_secret_1234"); // never the raw token
    const clear = run(["connect", "--clear"], deps as never);
    expect(clear.stdout).toContain("cleared");
  });

  it("a failing verification never persists a broken binding", () => {
    const bad: SyncTransport = () => ({ status: 401, response: { ok: false } });
    const deps = { cwd, env, transport: bad, now: "2026-08-12T00:00:00.000Z" };
    const res = run(["connect", "https://fly.example", "--token", "dk_wrong"], deps as never);
    expect(res.exitCode).not.toBe(0);
    expect(readGlobalConnect(env)).toBeNull();
  });
});
