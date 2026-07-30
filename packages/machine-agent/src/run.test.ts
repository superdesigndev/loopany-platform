import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseRepoAllowlist, type AgentConfig } from "./config.js";
import { executeDirective, type RunReporter } from "./execute.js";
import type { Gh } from "./gh.js";
import { checkRunPermitted, NEVER_EXECUTE } from "./guards.js";
import {
  composeInstruction,
  nodeExec,
  readFinding,
  resolveWorkdir,
  runCliToken,
  runEnv,
  runInstruction,
  INHERITED_ENV,
  type ExecInput,
  type RunDeps,
} from "./run.js";
import type { Directive, Instruction } from "./types.js";

/**
 * INSTRUCTION RUNS - the machine half of the runs bridge.
 *
 * Two layers, probed separately because they fail differently:
 *
 *   THE JAIL AND THE GUARDS are pure, so they are asserted directly. Every one of
 *   them is a fail-closed answer to "what may this machine do?", and every one is the
 *   sort of thing that is quietly correct until the day it is not.
 *
 *   THE SPAWN is asserted against a REAL child process, in a real temp directory,
 *   because that is the only way "a timeout kills the process group" and "the
 *   instruction never appears in argv" are claims rather than hopes. It uses `sh` with
 *   a here-script on stdin - no agent, no network, nothing outside the temp dir.
 */

let root: string;

function config(over: Partial<AgentConfig> = {}, run: Partial<AgentConfig["run"]> = {}): AgentConfig {
  return {
    serverUrl: "http://127.0.0.1:3780",
    token: "t",
    agent: "probe",
    pollMs: 1000,
    allowedRepos: parseRepoAllowlist("acme/widgets"),
    allowDefaultBranch: false,
    commentOnly: false,
    sensing: false,
    sensingIntervalMs: 60_000,
    run: { command: "sh", args: [], root, maxTimeoutMs: 10_000, maxOutputBytes: 4096, ...run },
    ...over,
  };
}

function spec(over: Partial<Instruction> = {}): Instruction {
  return {
    runId: "run-act-1",
    intent: "Count the files here and say what you found.",
    context: { dispatchedBy: "obj-1", object: { brief: "count the files" } },
    scope: { repos: [], writes: ["report.md"], timeoutMs: 5_000 },
    label: "count the files",
    report: true,
    ...over,
  };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-run-probe-"));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// ─────────────────────────────────────────────────────────────────────────────
// the jail
// ─────────────────────────────────────────────────────────────────────────────

describe("the workdir jail", () => {
  it("resolves a relative workdir inside the root", () => {
    const r = resolveWorkdir("/srv/runs", "task-7");
    expect(r.ok && r.dir).toBe(path.resolve("/srv/runs/task-7"));
  });

  it("defaults to the root itself", () => {
    const r = resolveWorkdir("/srv/runs", undefined);
    expect(r.ok && r.dir).toBe(path.resolve("/srv/runs"));
  });

  it("REFUSES a traversal that normalizes out of the root", () => {
    // The mistake a naive prefix check makes: `/srv/runs/../etc` is a string starting
    // with the root and a path that is nowhere near it.
    const r = resolveWorkdir("/srv/runs", "../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("outside this agent's run root");
  });

  it("REFUSES an absolute path outside the root", () => {
    expect(resolveWorkdir("/srv/runs", "/etc").ok).toBe(false);
    expect(resolveWorkdir("/srv/runs", "/tmp/anything").ok).toBe(false);
  });

  it("REFUSES a sibling that merely shares a string prefix", () => {
    // `/srv/runs-evil` starts with `/srv/runs` and is a different directory. The
    // separator-terminated fence is what catches it.
    expect(resolveWorkdir("/srv/runs", "../runs-evil").ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the pre-flight guards
// ─────────────────────────────────────────────────────────────────────────────

describe("what this machine will execute", () => {
  it("refuses everything with no executor configured", () => {
    const r = checkRunPermitted(config({}, { command: undefined }), { repos: [] });
    expect(r?.code).toBe("RUN_NOT_PERMITTED");
    expect(r?.error).toContain("NO instruction executor");
  });

  it("refuses everything with no run root", () => {
    const r = checkRunPermitted(config({}, { root: undefined }), { repos: [] });
    expect(r?.code).toBe("RUN_NOT_PERMITTED");
    expect(r?.error).toContain("NO run root");
  });

  it("REFUSES the loopany daemon as an executor, whatever the configuration says", () => {
    // The hard floor under the configuration. A live daemon runs somebody's real
    // scheduled work, and an instruction runner pointed at it could stop, restart or
    // re-register a real fleet - so this refusal lives in code, not in a document.
    for (const name of NEVER_EXECUTE) {
      expect(checkRunPermitted(config({}, { command: name }), { repos: [] })?.code).toBe("RUN_NOT_PERMITTED");
      // …and a path cannot walk around it: the check is on the resolved basename.
      expect(checkRunPermitted(config({}, { command: `/usr/local/bin/${name}` }), { repos: [] })?.code).toBe(
        "RUN_NOT_PERMITTED",
      );
      expect(checkRunPermitted(config({}, { command: `~/.local/bin/${name}` }), { repos: [] })?.code).toBe(
        "RUN_NOT_PERMITTED",
      );
    }
  });

  it("refuses a repo scope this machine does not allow", () => {
    const r = checkRunPermitted(config(), { repos: ["acme/widgets", "other/repo"] });
    expect(r?.code).toBe("RUN_NOT_PERMITTED");
    expect(r?.error).toContain("other/repo");
  });

  it("allows a scope inside the allowlist, and an empty scope", () => {
    expect(checkRunPermitted(config(), { repos: ["acme/widgets"] })).toBeUndefined();
    expect(checkRunPermitted(config(), { repos: [] })).toBeUndefined();
  });

  it("an EMPTY allowlist admits no repo scope at all", () => {
    const bare = config({ allowedRepos: parseRepoAllowlist("") });
    expect(checkRunPermitted(bare, { repos: ["acme/widgets"] })?.code).toBe("RUN_NOT_PERMITTED");
    // …but a run claiming no repo scope is still fine: not every instruction touches
    // GitHub, and refusing those would make the channel useless on a machine with no
    // repo allowlist at all.
    expect(checkRunPermitted(bare, { repos: [] })).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the composed instruction
// ─────────────────────────────────────────────────────────────────────────────

describe("the instruction handed to the executor", () => {
  it("carries the intent, the context and the boundary", () => {
    const text = composeInstruction(spec({ scope: { repos: ["acme/widgets"], writes: ["report.md"], timeoutMs: 30_000 } }));
    expect(text).toContain("Count the files here");
    expect(text).toContain('"brief": "count the files"');
    expect(text).toContain("acme/widgets");
    expect(text).toContain("30 seconds");
    expect(text).toContain("report.md");
  });

  it("always states the check-reality-first discipline", () => {
    // Decision 12's own answer to "how is an agent-executed effect idempotent?" - it
    // is instruction discipline, so it must be in EVERY instruction and not only the
    // declarations that remembered it.
    const text = composeInstruction(spec({ intent: "Reply to the customer." }));
    expect(text).toContain("CHECK REALITY FIRST");
    expect(text).toContain("delivered more than once");
  });

  it("says so plainly when there is NO repo scope", () => {
    const text = composeInstruction(spec());
    expect(text).toContain("NO repository scope");
  });

  it("always forbids copying a credential outward", () => {
    expect(composeInstruction(spec())).toContain("Never copy a credential");
  });

  /**
   * THE FINDING CONTRACT - stated only when the work order declares a path for one.
   *
   * Asking every run for a verdict its declaration binds nothing to would be putting
   * words in a spec's mouth, and would train agents to emit a line nobody reads.
   */
  it("asks for a finding only when the work order declares one", () => {
    expect(composeInstruction(spec())).not.toContain("FINDING:");
    const asked = composeInstruction(spec({ onFinding: "escalate" }));
    expect(asked).toContain("FINDING: discovery");
    expect(asked).toContain("FINDING: nothing-new");
    // Both halves of the declaration ask for it: a spec may care only about the
    // quiet path, and it still needs the run to say which one this was.
    expect(composeInstruction(spec({ onNothingNew: "stand-down" }))).toContain("FINDING:");
  });
});

describe("reading the run's own verdict off its output", () => {
  it("reads a declared line, anywhere in the output", () => {
    expect(readFinding("# Report\n\nfound a thing\n\nFINDING: discovery\n")).toBe("discovery");
    expect(readFinding("nothing changed\nFINDING: nothing-new")).toBe("nothing-new");
    // Case and surrounding whitespace are the agent's business, not ours.
    expect(readFinding("  FINDING:   Discovery  ")).toBe("discovery");
  });

  it("takes the LAST declaration, so a rehearsal never outranks the answer", () => {
    const output = ["End with FINDING: nothing-new if it was quiet.", "", "I found something.", "FINDING: discovery"].join("\n");
    expect(readFinding(output)).toBe("discovery");
  });

  it("returns nothing for a value outside the closed set, and never guesses", () => {
    // Guessing `discovery` would put noise in front of a person; guessing
    // `nothing-new` would hide a real find. An unparseable verdict is a run that did
    // not answer, and the server falls back to the plain success path.
    expect(readFinding("FINDING: maybe")).toBeUndefined();
    expect(readFinding("FINDING: discovery and also some prose")).toBeUndefined();
    expect(readFinding("a report with no verdict at all")).toBeUndefined();
    expect(readFinding("")).toBeUndefined();
  });
});

describe("the child's environment", () => {
  it("is an allowlist, never a spread of this process's env", () => {
    process.env.LOOPANY_AGENT_TOKEN = "shh-secret";
    const env = runEnv(spec(), "/srv/runs/x");
    expect(env.LOOPANY_AGENT_TOKEN).toBeUndefined();
    // Only the named keys plus the run's own facts.
    for (const key of Object.keys(env)) {
      expect(key.startsWith("LOOPANY_RUN_") || (INHERITED_ENV as readonly string[]).includes(key)).toBe(true);
    }
    expect(env.LOOPANY_RUN_ID).toBe("run-act-1");
    expect(env.LOOPANY_RUN_WORKDIR).toBe("/srv/runs/x");
    delete process.env.LOOPANY_AGENT_TOKEN;
  });

  it("hands the run its OWN credential, never this process's channel token", () => {
    process.env.LOOPANY_AGENT_TOKEN = "shh-secret";
    const env = runEnv(spec(), "/srv/runs/x", {
      serverUrl: "http://127.0.0.1:3840",
      token: runCliToken("shh-secret", "run-act-1"),
      binDir: "/opt/graph/bin",
    });
    // The secret that could claim ANY work order on this machine has no business
    // in a model's context (captain decision 15). What travels is derived, names
    // exactly one run, and dies with that run's lease.
    expect(env.LOOPANY_AGENT_TOKEN).toBeUndefined();
    expect(env.LOOPANY_RUN_TOKEN).toBe(runCliToken("shh-secret", "run-act-1"));
    expect(env.LOOPANY_RUN_TOKEN).not.toContain("shh-secret");
    expect(env.LOOPANY_GRAPH_SERVER_URL).toBe("http://127.0.0.1:3840");
    // `graph` is put on PATH by DIRECTORY, so the instruction names a command and
    // the machine decides which binary that is.
    expect(env.PATH?.startsWith("/opt/graph/bin:")).toBe(true);
    delete process.env.LOOPANY_AGENT_TOKEN;
  });

  it("derives the run credential the way the SERVER does", () => {
    // A GOLDEN VECTOR shared with `graph/cli/cli.test.ts` on the server side. The
    // two implementations are deliberately independent - this process must not
    // depend on the server's source tree - so this pair is what keeps them from
    // drifting: a change on either side fails both suites.
    expect(runCliToken("probe-channel-secret", "run-abc")).toBe("rt_d6a9f4bbe5d47860346705bb1a8a5654");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the real spawn
// ─────────────────────────────────────────────────────────────────────────────

describe("the sandboxed spawn, against a real child process", () => {
  const deps = (): RunDeps => ({
    exec: nodeExec,
    ensureDir: async (dir) => fs.promises.mkdir(dir, { recursive: true }).then(() => undefined),
    now: () => Date.now(),
  });

  /** A tiny executor script: reads the instruction on stdin and prints a report. */
  function runnerScript(body: string): string {
    const file = path.join(root, `runner-${Math.abs(hash(body))}.sh`);
    fs.writeFileSync(file, body, { mode: 0o755 });
    return file;
  }

  function hash(s: string): number {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
    return h;
  }

  it("runs the executor in the jailed workdir and captures its output", async () => {
    const script = runnerScript('#!/bin/sh\ninstruction=$(cat)\necho "# Report"\necho "cwd=$(pwd)"\necho "len=${#instruction}"\n');
    const outcome = await runInstruction(
      config({}, { command: "sh", args: [script] }),
      spec({ scope: { workdir: "probe-spawn", repos: [], writes: [], timeoutMs: 5_000 } }),
      deps(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.workdir).toBe(path.join(root, "probe-spawn"));
    expect(outcome.output).toContain(path.join(root, "probe-spawn"));
    // The instruction really arrived - on STDIN, which is the point.
    expect(outcome.output).toMatch(/len=[1-9]\d+/);
  });

  it("delivers the instruction on stdin and NEVER in argv", async () => {
    // A prompt containing shell metacharacters is just text. If it reached argv - or a
    // shell - this would either break or execute something.
    const script = runnerScript('#!/bin/sh\nargs="$*"\ncat > instruction.txt\necho "args=[$args]"\n');
    const nasty = 'Reply to "$(touch pwned)" and `rm -rf /` politely.';
    const outcome = await runInstruction(
      config({}, { command: "sh", args: [script] }),
      spec({ intent: nasty, scope: { workdir: "probe-argv", repos: [], writes: [], timeoutMs: 5_000 } }),
      deps(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output.trim()).toBe("args=[]");
    // The bytes landed intact…
    const written = fs.readFileSync(path.join(root, "probe-argv", "instruction.txt"), "utf8");
    expect(written).toContain(nasty);
    // …and nothing was executed: the substitution never ran.
    expect(fs.existsSync(path.join(root, "probe-argv", "pwned"))).toBe(false);
  });

  it("reports a non-zero exit as RUN_FAILED, never as a success", async () => {
    const script = runnerScript('#!/bin/sh\ncat > /dev/null\necho "it broke" >&2\nexit 3\n');
    const outcome = await runInstruction(
      config({}, { command: "sh", args: [script] }),
      spec({ scope: { workdir: "probe-fail", repos: [], writes: [], timeoutMs: 5_000 } }),
      deps(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal?.code).toBe("RUN_FAILED");
    expect(outcome.exitCode).toBe(3);
    // stderr is captured too - the reason is usually there.
    expect(outcome.output).toContain("it broke");
  });

  it("KILLS a run that outlives its timeout, and its children with it", async () => {
    // The child spawns a grandchild that would outlive it. Killing the process GROUP
    // is what makes an executor that spawned a coding agent actually stop.
    const marker = path.join(root, "probe-timeout", "grandchild-lived");
    const script = runnerScript(
      `#!/bin/sh\ncat > /dev/null\n( sleep 5; echo lived > "${marker}" ) &\necho "started"\nsleep 5\n`,
    );
    const outcome = await runInstruction(
      config({}, { command: "sh", args: [script] }),
      spec({ scope: { workdir: "probe-timeout", repos: [], writes: [], timeoutMs: 400 } }),
      deps(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal?.code).toBe("RUN_TIMEOUT");
    expect(outcome.durationMs).toBeLessThan(4_000);
    // Give the grandchild every chance to have survived, then assert it did not.
    await new Promise((r) => setTimeout(r, 800));
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  it("clamps a work order's timeout to this machine's own maximum", async () => {
    const seen: number[] = [];
    const outcome = await runInstruction(
      config({}, { command: "sh", args: ["-c", "true"], maxTimeoutMs: 1_500 }),
      spec({ scope: { repos: [], writes: [], timeoutMs: 60 * 60 * 1000 } }),
      {
        ...deps(),
        exec: async (input: ExecInput) => {
          seen.push(input.timeoutMs);
          return { exitCode: 0, signal: null, timedOut: false, output: "", truncated: false };
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([1_500]);
  });

  it("BOUNDS captured output and says that it did", async () => {
    const script = runnerScript('#!/bin/sh\ncat > /dev/null\nawk \'BEGIN{ for(i=0;i<5000;i++) print "xxxxxxxxxxxxxxxx" }\'\n');
    const outcome = await runInstruction(
      config({}, { command: "sh", args: [script], maxOutputBytes: 2048 }),
      spec({ scope: { workdir: "probe-output", repos: [], writes: [], timeoutMs: 8_000 } }),
      deps(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.output, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("reports a missing executor as an agent error, not a crash", async () => {
    const outcome = await runInstruction(
      config({}, { command: path.join(root, "definitely-not-here") }),
      spec({ scope: { repos: [], writes: [], timeoutMs: 2_000 } }),
      deps(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal?.code).toBe("AGENT_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the lifecycle, as the executor drives it
// ─────────────────────────────────────────────────────────────────────────────

describe("the run lifecycle an executed work order reports", () => {
  const gh: Gh = {
    async view() {
      throw new Error("an instruction run must not touch GitHub through the effect path");
    },
    async comment() {
      throw new Error("no");
    },
    async merge() {
      throw new Error("no");
    },
    async fetchPrs() {
      throw new Error("no");
    },
  };

  function runDirective(payload: Record<string, unknown> = {}): Directive {
    return {
      id: "act-run-1",
      kind: "run-task",
      teamId: "team",
      objectId: "obj-task-1",
      target: { source: "machine", externalId: "run/run-act-run-1", repo: null, number: null },
      payload: {
        runId: "run-act-run-1",
        intent: "Do the thing described in context.object.brief.",
        context: { object: { brief: "do the thing" } },
        scope: { workdir: "probe-lifecycle", repos: [], writes: [], timeoutMs: 5_000 },
        label: "do the thing",
        onSuccess: "succeeded",
        onFailure: "broke",
        report: true,
        ...payload,
      },
      approval: {
        eventId: "ev-1",
        entrance: "human",
        actorId: "u-captain",
        ts: "2026-07-30T09:00:00.000Z",
        transition: "approve",
      },
      attempts: 1,
      leaseExpiresAt: "2026-07-30T09:01:00.000Z",
      createdAt: "2026-07-30T09:00:00.000Z",
    };
  }

  function reporter(): RunReporter & { calls: string[]; reports: string[]; findings: (string | undefined)[] } {
    const calls: string[] = [];
    const reports: string[] = [];
    const findings: (string | undefined)[] = [];
    return {
      calls,
      reports,
      findings,
      async started() {
        calls.push("started");
      },
      async finished(_d, outcome, detail) {
        calls.push(`finished:${outcome}`);
        findings.push(detail.finding);
        if (detail.report) reports.push(detail.report);
      },
    };
  }

  it("reports started BEFORE the work and finished after, with the output as the report", async () => {
    const script = path.join(root, "lifecycle-ok.sh");
    fs.writeFileSync(script, '#!/bin/sh\ncat > /dev/null\necho "# Did the thing"\necho "nothing needed changing"\n', { mode: 0o755 });
    const r = reporter();
    const outcome = await executeDirective(
      config({}, { command: "sh", args: [script] }),
      { gh, run: { exec: nodeExec, ensureDir: async (d) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined), now: () => Date.now() }, runReporter: r },
      runDirective(),
    );
    expect(outcome.ok).toBe(true);
    // ORDER MATTERS: a run that died mid-flight must still have left a trace of having
    // begun, which is only true if `started` lands before the executor spawns.
    expect(r.calls).toEqual(["started", "finished:success"]);
    expect(r.reports[0]).toContain("nothing needed changing");
    // The Timeline summary skips the markdown heading marker and reads as prose.
    if (outcome.ok) expect(outcome.result.detail).toContain("Did the thing");
  });

  /**
   * THE WHOLE POINT OF THE CONTRACT, end to end on the machine side: a run that
   * declares a discovery is reported as one, so the server can take the declared
   * `onFinding` path and put the report in front of a person.
   */
  it("reports the finding the run declared, when the work order asked for one", async () => {
    const script = path.join(root, "lifecycle-finding.sh");
    fs.writeFileSync(script, '#!/bin/sh\ncat > /dev/null\necho "# Found it"\necho "FINDING: discovery"\n', { mode: 0o755 });
    const r = reporter();
    await executeDirective(
      config({}, { command: "sh", args: [script] }),
      { gh, run: { exec: nodeExec, ensureDir: async (d) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined), now: () => Date.now() }, runReporter: r },
      runDirective({ onFinding: "escalate", onNothingNew: "stand-down" }),
    );
    expect(r.calls).toEqual(["started", "finished:success"]);
    expect(r.findings).toEqual(["discovery"]);
  });

  it("reports NO finding when the work order never asked for one", async () => {
    // The same output against a declaration with no finding path: the line is prose
    // the agent happened to print, and reporting it would claim a contract the spec
    // never entered into.
    const script = path.join(root, "lifecycle-unasked.sh");
    fs.writeFileSync(script, '#!/bin/sh\ncat > /dev/null\necho "FINDING: discovery"\n', { mode: 0o755 });
    const r = reporter();
    await executeDirective(
      config({}, { command: "sh", args: [script] }),
      { gh, run: { exec: nodeExec, ensureDir: async (d) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined), now: () => Date.now() }, runReporter: r },
      runDirective(),
    );
    expect(r.findings).toEqual([undefined]);
  });

  it("reports no finding from a run that BROKE, whatever it printed", async () => {
    const script = path.join(root, "lifecycle-finding-fail.sh");
    fs.writeFileSync(script, '#!/bin/sh\ncat > /dev/null\necho "FINDING: discovery"\nexit 3\n', { mode: 0o755 });
    const r = reporter();
    await executeDirective(
      config({}, { command: "sh", args: [script] }),
      { gh, run: { exec: nodeExec, ensureDir: async (d) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined), now: () => Date.now() }, runReporter: r },
      runDirective({ onFinding: "escalate" }),
    );
    expect(r.calls).toEqual(["started", "finished:failure"]);
    expect(r.findings).toEqual([undefined]);
  });

  it("reports finished:failure and the typed refusal when the run breaks", async () => {
    const script = path.join(root, "lifecycle-fail.sh");
    fs.writeFileSync(script, "#!/bin/sh\ncat > /dev/null\nexit 9\n", { mode: 0o755 });
    const r = reporter();
    const outcome = await executeDirective(
      config({}, { command: "sh", args: [script] }),
      { gh, run: { exec: nodeExec, ensureDir: async (d) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined), now: () => Date.now() }, runReporter: r },
      runDirective(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("RUN_FAILED");
    expect(r.calls).toEqual(["started", "finished:failure"]);
  });

  it("refuses BEFORE reporting anything when the approval is not human", async () => {
    const r = reporter();
    const d = runDirective();
    const outcome = await executeDirective(
      config(),
      { gh, runReporter: r },
      { ...d, approval: { eventId: "ev", entrance: "rule", actorId: "rule-x", ts: "t", transition: null } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("APPROVAL_INVALID");
    // No lifecycle at all: an unapproved run never began.
    expect(r.calls).toEqual([]);
  });

  it("refuses a work order with no instruction", async () => {
    const d = runDirective();
    const outcome = await executeDirective(config(), { gh }, { ...d, payload: { runId: "run-x" } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("TARGET_UNRESOLVED");
  });

  it("refuses when this agent cannot run instructions at all", async () => {
    const outcome = await executeDirective(config({}, { command: undefined }), { gh }, runDirective());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("RUN_NOT_PERMITTED");
  });
});
