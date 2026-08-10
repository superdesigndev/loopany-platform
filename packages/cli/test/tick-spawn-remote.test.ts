/**
 * M6 regression — `tick --spawn` against a REMOTE backend must refuse with ZERO
 * remote interaction.
 *
 * `--spawn` is the LOCAL agent loop (§5.2): it claims each pending run and launches
 * the assignee's config profile as a subprocess against THIS machine. A remote
 * backend's pending runs belong to the server's fleet, so the CLI must refuse
 * SPAWN_REMOTE_UNSUPPORTED. The bug (fixed here) ran `backend.tick(now)` — which
 * POSTs `{tick:true}` to the server and fires due crons at the AUTHORITY — BEFORE
 * the backend-kind guard, mutating remote state and then discarding the result.
 *
 * The guard: an injected fake transport records every call. A correct refusal fires
 * before any tick, so the transport is NEVER called.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliDeps, WORKSPACE_DIR, run } from "../src/index.js";

const SERVER_URL = "https://loopany.example";
const TOKEN = "dk_test-token";
const NOW = "2026-08-10T09:30:00.000Z";

describe("M6 remote `tick --spawn` refuses before any remote interaction", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-m6-spawn-"));
    // A workspace whose backend is the remote URL, so `run(...)` selects the
    // RemoteBackend and the injected transport carries any POST.
    mkdirSync(join(dir, WORKSPACE_DIR), { recursive: true });
    writeFileSync(
      join(dir, WORKSPACE_DIR, "config.json"),
      JSON.stringify({ backend: SERVER_URL, createdAt: NOW, token: TOKEN }, null, 2) + "\n",
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 with SPAWN_REMOTE_UNSUPPORTED and NEVER touches the transport", () => {
    const calls: unknown[] = [];
    const transport: NonNullable<CliDeps["transport"]> = (_url, _token, body) => {
      // Record every remote interaction. A correct refusal fires BEFORE the tick,
      // so this must never run — the pre-tick guard is the whole point.
      calls.push(body);
      return { status: 200, response: { ok: true, notices: [], applied: 0 } };
    };
    const deps: CliDeps = { cwd: dir, now: NOW, env: {}, transport };

    const out = run(["tick", "--spawn"], deps);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: SPAWN_REMOTE_UNSUPPORTED");
    // The refusal fired with ZERO remote interaction — no tick POSTed, no cron
    // fired at the authority, no runs created.
    expect(calls).toEqual([]);
  });

  it("a remote tick WITHOUT --spawn still reaches the transport (guard is spawn-only)", () => {
    const calls: unknown[] = [];
    const transport: NonNullable<CliDeps["transport"]> = (_url, _token, body) => {
      calls.push(body);
      return { status: 200, response: { ok: true, notices: [], applied: 0 } };
    };
    const deps: CliDeps = { cwd: dir, now: NOW, env: {}, transport };

    const out = run(["tick"], deps);
    expect(out.exitCode).toBe(0);
    // The plain remote tick DID POST — the guard narrows to `--spawn` only.
    expect(calls).toEqual([{ tick: true, now: NOW }]);
  });
});
