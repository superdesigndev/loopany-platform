import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { readUserSession, writeUserSession, type UserSession } from "../src/userSession.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function session(): UserSession {
  return { kind: "loopany-user-session", schemaVersion: 1, server: "https://kernel.example", accessToken: "human-session", expiresAt: "2030-01-01T00:00:00.000Z", user: { id: "u-stone", email: "stone@example.com", name: "Stone" } };
}

describe("lk setup /workspace", () => {
  it("shows canonical people and executable agent addresses for the selected Team", () => {
    const home = mkdtempSync(join(tmpdir(), "lk-team-")); homes.push(home);
    const env = { LOOPANY_HOME: home };
    writeUserSession(env, { ...session(), teamId: "team-superdesign" });
    const out = run(["team"], {
      cwd: home, now: "2026-08-13T00:00:00.000Z", env,
      teamDirectory: () => ({
        team: { id: "team-superdesign", name: "Superdesign", slug: "superdesign", path: "/superdesign" },
        people: [{ id: "u-stone", email: "stone@example.com", role: "owner" }],
        machines: [],
        agents: [{ address: "stone-mbp/codex", machineId: "m-stone", machine: "stone-mbp", profile: "codex", availability: "available", lastSucceededAt: null }],
      }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("stone@example.com  person:u-stone");
    expect(out.stdout).toContain("stone-mbp/codex  available");
  });

  it("logs in when needed, starts one runtime, binds the owned Machine, and selects the Team", () => {
    const home = mkdtempSync(join(tmpdir(), "lk-setup-")); homes.push(home);
    const env = { LOOPANY_HOME: home };
    const calls: string[] = [];
    const out = run(["setup", "/superdesign", "--server", "https://kernel.example"], {
      cwd: home, now: "2026-08-13T00:00:00.000Z", env,
      login: (server, targetEnv) => { calls.push(`login:${server}`); writeUserSession(targetEnv, session()); return session(); },
      teams: () => [{ id: "team-superdesign", name: "Superdesign", slug: "superdesign", path: "/superdesign" }],
      setupRuntime: (server) => { calls.push(`runtime:${server}`); return "m-stone"; },
      bindMachine: (_session, slug, machineId) => { calls.push(`bind:${slug}:${machineId}`); return { team: { id: "team-superdesign", name: "Superdesign", slug, path: `/${slug}` }, machine: { id: machineId, alias: "stone-mbp" } }; },
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual(["login:https://kernel.example", "runtime:https://kernel.example", "bind:superdesign:m-stone"]);
    expect(readUserSession(env)?.teamId).toBe("team-superdesign");
    expect(out.stdout).toContain("Workspace: /superdesign");
    expect(out.stdout).toContain("Daemon: running");
  });

  it("reuses login and refuses a workspace outside current membership before touching the runtime", () => {
    const home = mkdtempSync(join(tmpdir(), "lk-setup-")); homes.push(home);
    const env = { LOOPANY_HOME: home }; writeUserSession(env, session());
    let runtime = false;
    const out = run(["setup", "/other"], { cwd: home, now: "2026-08-13T00:00:00.000Z", env, teams: () => [], setupRuntime: () => { runtime = true; return "m-x"; } });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("not a member");
    expect(runtime).toBe(false);
  });

  it("requires a server only on first setup", () => {
    const home = mkdtempSync(join(tmpdir(), "lk-setup-")); homes.push(home);
    const out = run(["setup", "/superdesign"], { cwd: home, now: "2026-08-13T00:00:00.000Z", env: { LOOPANY_HOME: home } });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("first setup needs --server");
  });

  it("re-authenticates and resumes setup when the cached human session expired", () => {
    const home = mkdtempSync(join(tmpdir(), "lk-setup-")); homes.push(home);
    const env = { LOOPANY_HOME: home }; writeUserSession(env, session());
    let teamReads = 0;
    let logins = 0;
    const out = run(["setup", "/superdesign", "--server", "https://kernel.example"], {
      cwd: home, now: "2026-08-13T00:00:00.000Z", env,
      teams: () => {
        teamReads += 1;
        if (teamReads === 1) throw new Error("session expired; run lk login");
        return [{ id: "team-superdesign", name: "Superdesign", slug: "superdesign", path: "/superdesign" }];
      },
      login: (_server, targetEnv) => { logins += 1; writeUserSession(targetEnv, session()); return session(); },
      setupRuntime: () => "m-stone",
      bindMachine: (_session, slug, machineId) => ({ team: { id: "team-superdesign", name: "Superdesign", slug, path: `/${slug}` }, machine: { id: machineId } }),
    });
    expect(out.exitCode).toBe(0);
    expect(logins).toBe(1);
    expect(teamReads).toBe(2);
    expect(out.stdout).toContain("Workspace: /superdesign");
  });
});
