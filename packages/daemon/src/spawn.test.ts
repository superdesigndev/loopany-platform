/**
 * spawn helpers — the child-env allowlists (allowlistEnv / execEnv) and the
 * process-GROUP kill: a timed-out child's grandchildren (e.g. a workflow's
 * mcporter stdio servers) must not survive the timeout.
 */
import os from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { isAlive } from "./pidfile.js";
import { allowlistEnv, execEnv, runProcess } from "./spawn.js";

// Save/restore every env key a test touches so nothing leaks across tests.
const saved = new Map<string, string | undefined>();
function setEnv(k: string, v: string): void {
  if (!saved.has(k)) saved.set(k, process.env[k]);
  process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe("execEnv", () => {
  test("keeps claude auth/config keys — incl. the ANTHROPIC_* proxy family and CLAUDE_CONFIG_DIR", () => {
    setEnv("ANTHROPIC_API_KEY", "sk-x");
    setEnv("ANTHROPIC_BASE_URL", "https://gw.example"); // proxy/gateway users
    setEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    setEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-config"); // relocated config → transcripts stay findable
    const env = execEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-config");
    expect(env.PATH).toBe(process.env.PATH);
  });

  test("drops unrelated shell secrets", () => {
    setEnv("AWS_SECRET_ACCESS_KEY", "leak-me-not");
    setEnv("GITHUB_TOKEN", "leak-me-not");
    setEnv("LOOPANY_TOKEN", "dk_secret"); // the device token never reaches claude
    const env = execEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.LOOPANY_TOKEN).toBeUndefined();
  });
});

describe("allowlistEnv", () => {
  test("prefix families pass through; everything outside the allowlist is dropped", () => {
    setEnv("LOOPANY_WORKFLOW_TOOL_RESULT_CAP", "1024");
    setEnv("LOOPANY_TOKEN", "dk_secret"); // NOT under the workflow prefix
    setEnv("SOME_RANDOM_SECRET", "leak-me-not");
    const env = allowlistEnv({ prefixes: ["LOOPANY_WORKFLOW_"] });
    expect(env.LOOPANY_WORKFLOW_TOOL_RESULT_CAP).toBe("1024");
    expect(env.LOOPANY_TOKEN).toBeUndefined();
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
  });

  test("extra exact keys join the base set", () => {
    setEnv("EXTRA_KEY_FOR_TEST", "yes");
    const env = allowlistEnv({ keys: ["EXTRA_KEY_FOR_TEST"] });
    expect(env.EXTRA_KEY_FOR_TEST).toBe("yes");
    expect(env.HOME).toBe(process.env.HOME);
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("runProcess — process-group kill (posix)", () => {
  test("a timed-out child's grandchild dies with it", async () => {
    if (process.platform === "win32") return; // no process groups on win32 (plain kill fallback)
    // The child spawns a long-sleeping grandchild, prints its pid, then idles
    // until the runProcess timeout SIGTERMs the whole group.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn("sleep", ["120"], { stdio: "ignore" });',
      'console.log("GRANDCHILD=" + g.pid);',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const r = await runProcess(process.execPath, ["-e", script], { cwd: os.tmpdir(), timeoutMs: 1000 });
    expect(r.timedOut).toBe(true);
    const m = r.stdout.match(/GRANDCHILD=(\d+)/);
    expect(m).toBeTruthy();
    const gpid = Number(m![1]);
    expect(await waitFor(() => !isAlive(gpid), 5000)).toBe(true);
  }, 20000);
});
