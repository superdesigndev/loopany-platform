import { describe, expect, it } from "vitest";

import { readEnv, run, type CliDeps } from "./cli.js";

/**
 * PROBE SUITE — the `graph` binary as a TEXT SINK.
 *
 * Everything here is about what this process is responsible for and nothing
 * else: finding its identity, inlining the one file its verb needs, and printing
 * exactly what the server said. The verbs' behaviour is the server's suite; if
 * this file ever starts asserting what a verb DOES, the CLI has grown a second
 * renderer and captain decision 16's "one surface" claim has quietly stopped
 * being true.
 *
 * Every seam is injected, so none of this touches a network, a disk or a clock.
 */

interface Recorded {
  url: string;
  body: unknown;
  token: string;
}

function deps(over: Partial<CliDeps> = {}, answer: Record<string, unknown> = { text: "ok", exitCode: 0 }) {
  const out: string[] = [];
  const sent: Recorded[] = [];
  const base: CliDeps = {
    env: { runId: "run-1", token: "rt_abc", serverUrl: "http://127.0.0.1:3840" },
    post: async (url, body, token) => {
      sent.push({ url, body, token });
      return { status: 200, body: answer };
    },
    readFile: async () => {
      throw new Error("ENOENT");
    },
    write: (t) => out.push(t),
    writeErr: (t) => out.push(t),
    ...over,
  };
  return { deps: base, out, sent };
}

describe("probe: it prints what the server said, and nothing of its own", () => {
  it("POSTs argv with the run's credential and echoes the text verbatim", async () => {
    const { deps: d, out, sent } = deps({}, { text: "review request:\n  result: waiting on a person", exitCode: 0 });
    const code = await run(["review", "request", "--question", "well?"], d);

    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://127.0.0.1:3840/api/agent/cli");
    expect(sent[0]!.token).toBe("rt_abc");
    expect(sent[0]!.body).toEqual({ runId: "run-1", argv: ["review", "request", "--question", "well?"] });
    // VERBATIM. The one addition is a trailing newline, because a shell needs it.
    expect(out.join("")).toBe("review request:\n  result: waiting on a person\n");
  });

  it("returns the server's exit code, so a refusal is a non-zero exit", async () => {
    const { deps: d } = deps({}, { text: "error: nope\ncode: FORBIDDEN", exitCode: 1 });
    expect(await run(["wait", "open", "x"], d)).toBe(1);
  });

  it("says SERVER_TOO_OLD rather than printing nothing", async () => {
    // A blank success is the worst possible answer for an agent - it reads as
    // "that worked". A definitive error is the only honest one.
    const { deps: d, out } = deps({}, { ok: true });
    expect(await run(["task", "create"], d)).toBe(1);
    expect(out.join("")).toContain("SERVER_TOO_OLD");
  });

  it("names exactly which identity is missing", async () => {
    const { deps: d, out } = deps({ env: { runId: "run-1" } });
    expect(await run(["task", "create"], d)).toBe(2);
    const text = out.join("");
    expect(text).toContain("UNCONFIGURED");
    expect(text).toContain("LOOPANY_RUN_TOKEN");
    expect(text).toContain("LOOPANY_GRAPH_SERVER_URL");
    expect(text).not.toContain("LOOPANY_RUN_ID");
  });

  it("reports an unreachable server as one line, not a stack", async () => {
    const { deps: d, out } = deps({
      post: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await run(["task", "create"], d)).toBe(1);
    expect(out.join("")).toContain("UNREACHABLE");
    expect(out.join("")).not.toContain("at Object.");
  });
});

describe("probe: the file a verb names is inlined HERE", () => {
  it("reads the artifact's bytes and sends them in the body", async () => {
    const { deps: d, sent } = deps({ readFile: async (p) => `# ${p}\n\nbody\n` });
    await run(["artifact", "push", "report.md", "--title", "Report"], d);
    const argv = (sent[0]!.body as { argv: string[] }).argv;
    // The server never touches a disk, which is also why it cannot read one.
    expect(argv).toContain("--body");
    expect(argv[argv.indexOf("--body") + 1]).toBe("# report.md\n\nbody\n");
    // The path survives as a positional, for the title fallback.
    expect(argv).toContain("report.md");
  });

  it("refuses an unreadable artifact before the upload", async () => {
    const { deps: d, out, sent } = deps();
    expect(await run(["artifact", "push", "missing.md"], d)).toBe(2);
    expect(sent).toHaveLength(0);
    expect(out.join("")).toContain("cannot read missing.md");
  });

  it("refuses an artifact over the cap before the upload", async () => {
    const { deps: d, sent } = deps({ readFile: async () => "x".repeat(600_000) });
    expect(await run(["artifact", "push", "huge.md"], d)).toBe(2);
    expect(sent).toHaveLength(0);
  });

  it("treats --evidence as a file when it reads, and as prose when it does not", async () => {
    const asFile = deps({ readFile: async () => "0 occurrences\n" });
    await run(["wait", "answer", "obj", "verify", "--met", "--evidence", "./evidence.txt"], asFile.deps);
    const fileArgv = (asFile.sent[0]!.body as { argv: string[] }).argv;
    expect(fileArgv[fileArgv.indexOf("--evidence") + 1]).toBe("0 occurrences\n");

    // A watcher answering "I saw zero" should not have to write a file first.
    const asProse = deps();
    await run(["wait", "answer", "obj", "verify", "--met", "--evidence", "I saw zero"], asProse.deps);
    const proseArgv = (asProse.sent[0]!.body as { argv: string[] }).argv;
    expect(proseArgv[proseArgv.indexOf("--evidence") + 1]).toBe("I saw zero");
  });
});

describe("probe: the environment is the identity", () => {
  it("reads the three variables the machine agent sets, and trims the server URL", () => {
    expect(
      readEnv({
        LOOPANY_RUN_ID: " run-9 ",
        LOOPANY_RUN_TOKEN: "rt_x",
        LOOPANY_GRAPH_SERVER_URL: "http://127.0.0.1:3840/",
      }),
    ).toEqual({ runId: "run-9", token: "rt_x", serverUrl: "http://127.0.0.1:3840" });
    expect(readEnv({})).toEqual({});
  });
});
