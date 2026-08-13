import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearUserSession, readUserSession, revokeUserSession, selectTeam, sessionPath, writeUserSession, type UserSession } from "../src/userSession.js";

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lk-user-session-"));
  env = { LOOPANY_HOME: home };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function fixture(): UserSession {
  return {
    kind: "loopany-user-session",
    schemaVersion: 1,
    server: "https://loopany.example",
    accessToken: "opaque-session-token",
    expiresAt: "2030-01-01T00:00:00.000Z",
    user: { id: "u-1", email: "me@example.com", name: "Me" },
  };
}

describe("human CLI session", () => {
  it("writes atomically with owner-only permissions and preserves the stable identity", () => {
    writeUserSession(env, fixture());
    expect(statSync(sessionPath(env)).mode & 0o777).toBe(0o600);
    expect(readUserSession(env)).toEqual(fixture());
    expect(readFileSync(sessionPath(env), "utf8")).not.toContain("mk_");
  });

  it("selects a team without changing the credential and clears cleanly", () => {
    writeUserSession(env, fixture());
    const selected = selectTeam(env, "team-a");
    expect(selected.teamId).toBe("team-a");
    expect(selected.accessToken).toBe(fixture().accessToken);
    expect(clearUserSession(env)).toBe(true);
    expect(readUserSession(env)).toBeNull();
    expect(clearUserSession(env)).toBe(false);
  });

  it("fails closed on malformed session files", () => {
    const bad = { ...fixture(), kind: "machine", accessToken: "" } as unknown as UserSession;
    writeUserSession(env, bad);
    expect(readUserSession(env)).toBeNull();
  });

  it("revokes through Better Auth with the server origin for CSRF validation", () => {
    let captured: Parameters<typeof import("node:child_process").spawnSync> | undefined;
    const run = ((...args: Parameters<typeof import("node:child_process").spawnSync>) => {
      captured = args;
      return { status: 0 };
    }) as typeof import("node:child_process").spawnSync;
    revokeUserSession(fixture(), run);
    const options = captured?.[2] as { env?: Record<string, string> };
    expect(options.env?.U).toBe("https://loopany.example/api/auth/sign-out");
    expect(options.env?.O).toBe("https://loopany.example");
    expect(captured?.[1]?.join(" ")).not.toContain(fixture().accessToken);
    expect(captured?.[1]?.join(" ")).toContain("'content-type':'application/json'");
    expect(captured?.[1]?.join(" ")).toContain("body:'{}'");
  });
});
