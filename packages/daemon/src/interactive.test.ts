/**
 * `buildPatch` / `parseFlags` — the `loopany edit` patch assembly (batch-2 slim
 * surface: JSON-only + the content trio). Proves the whole envelope travels via a
 * single `--json '<obj>'`, the convenience `--*-file` content flags read a file's
 * raw content, and a REMOVED scalar flag (--cron/--tz/--pause/…) or any other
 * unknown flag now fails LOUDLY with "unknown flag … try --help". The server is the
 * sole validator, so these tests only assert the SHAPE the daemon sends.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { buildPatch, type InteractiveDeps, parseFlags, runInteractive } from "./interactive.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "loopany-edit-"));

describe("buildPatch", () => {
  test("the whole patch travels via a single --json object", () => {
    const { flags } = parseFlags(["--json", '{"cron":"0 9 * * *","goal":"ship v1","enabled":true}']);
    expect(buildPatch(flags)).toEqual({ cron: "0 9 * * *", goal: "ship v1", enabled: true });
  });

  test("--json passes through a null (goal:null clears the goal server-side)", () => {
    expect(buildPatch(parseFlags(["--json", '{"goal":null}']).flags)).toEqual({ goal: null });
  });

  test("--workflow-file / --ui-file read raw content into the patch", () => {
    const dir = tmp();
    const wf = path.join(dir, "wf.js");
    const ui = path.join(dir, "ui.html");
    writeFileSync(wf, "export default () => ({})\n");
    writeFileSync(ui, "<div>hi</div>");
    const { flags } = parseFlags(["--workflow-file", wf, "--ui-file", ui]);
    expect(buildPatch(flags)).toEqual({ workflow: "export default () => ({})\n", ui: "<div>hi</div>" });
  });

  test("--schema-file is parsed as JSON into stateSchema", () => {
    const dir = tmp();
    const schema = path.join(dir, "schema.json");
    writeFileSync(schema, '[{"key":"mrr","label":"MRR","unit":"$"}]');
    const { flags } = parseFlags(["--schema-file", schema]);
    expect(buildPatch(flags)).toEqual({ stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }] });
  });

  test("explicit --json keys win over the file flags", () => {
    const dir = tmp();
    const wf = path.join(dir, "wf.js");
    writeFileSync(wf, "// from file\n");
    const { flags } = parseFlags(["--workflow-file", wf, "--json", '{"workflow":"// from json"}']);
    expect(buildPatch(flags)).toEqual({ workflow: "// from json" });
  });

  test("--dry-run is a mode, not a patch key (ignored by buildPatch)", () => {
    expect(buildPatch(parseFlags(["--dry-run", "--json", '{"name":"x"}']).flags)).toEqual({ name: "x" });
  });

  test("a REMOVED scalar flag fails loudly with unknown-flag guidance", () => {
    for (const removed of ["--cron", "--tz", "--name", "--notify", "--model", "--pause", "--resume", "--run-at", "--task-file", "--json-file"]) {
      const argv = removed === "--pause" || removed === "--resume" ? [removed] : [removed, "x"];
      expect(() => buildPatch(parseFlags(argv).flags)).toThrow(/unknown flag/);
    }
  });

  test("--json rejects a non-object (array/scalar)", () => {
    expect(() => buildPatch(parseFlags(["--json", "[1,2]"]).flags)).toThrow(/must be a JSON object/);
    expect(() => buildPatch(parseFlags(["--json", '"x"']).flags)).toThrow(/must be a JSON object/);
  });

  test("invalid --json throws (surfaced to the user)", () => {
    expect(() => buildPatch(parseFlags(["--json", "{not json}"]).flags)).toThrow();
  });

  test("no edit flags yields an empty patch", () => {
    expect(buildPatch(parseFlags([]).flags)).toEqual({});
  });
});

/**
 * `runInteractive` fetch path with the token/server/fetch INJECTED so nothing touches
 * ~/.loopany. Proves `loops`/`edit` funnel through the unified `/api/machine/cli`
 * dispatch (NEW server), AND fall back to the legacy `/api/machine/loop` GET/PATCH
 * when the server 404s the unified endpoint (OLD server) — both halves of the matrix.
 */
function capture(extra: InteractiveDeps = {}): InteractiveDeps & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    server: "https://srv.test",
    token: "dk_test",
    stdout: () => out,
    stderr: () => err,
    ...extra,
  };
}

/** A fetch stub recording each {url, method, argv?, body?}; unified when argv present. */
function stub(handler: (req: { url: string; method: string; argv: string[]; parsedBody: any }) => { ok: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; argv: string[]; parsedBody: any }> = [];
  const fetchFn = (async (url: string, init: any) => {
    const parsedBody = init?.body ? JSON.parse(init.body) : undefined;
    const req = { url: String(url), method: init?.method ?? "GET", argv: parsedBody?.argv ?? [], parsedBody };
    calls.push(req);
    const r = handler(req);
    return { ok: r.ok, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("runInteractive — text sink (new server renders TOON in `text`)", () => {
  test("loops → posts {argv:['loops']} and prints the server's `text` verbatim, exit `exitCode`", async () => {
    const toon = "count: 1\nloops[1]{id,name,cron,enabled,nextFire}:\n  loop-1,Cookie,\"0 8 * * *\",on,—";
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops"
        ? { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: toon, exitCode: 0 } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops"], cap)).toBe(0);
    expect(calls[0]!.url).toBe("https://srv.test/api/machine/cli");
    expect(calls[0]!.argv).toEqual(["loops"]);
    // The daemon is a dumb sink: it prints the server's `text`, not its own render.
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("edit → prints the server `text` and honors its `exitCode` (a rejection dry-run exits 1)", async () => {
    const toon = "dry-run: Cookie — 0 changes valid, 1 rejected\nrejections[1]{key,reason}:\n  notify,bad";
    const { fetchFn } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "edit"
        ? { ok: false, body: { text: toon, exitCode: 1 } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1", "--json", '{"notify":"x"}', "--dry-run"], cap)).toBe(1);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("a pre-`text` unified server (200, no text) falls back to the retained structured render", async () => {
    const { fetchFn } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops"
        ? { ok: true, body: { ok: true, loops: [{ id: "loop-1", name: "Cookie", cron: "0 8 * * *", timezone: "UTC", enabled: true, notify: "smart", nextRunAt: null }] } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops"], cap)).toBe(0);
    expect(cap.stdout()).toContain("loop-1");
    expect(cap.stdout()).toContain("Cookie");
  });
});

describe("runInteractive — loops forwards its flags (F1–F4: the old bug hardcoded ['loops'])", () => {
  test("--fields is forwarded verbatim so the server can honor it (F1)", async () => {
    const toon = "count: 1\nloops[1]{id,name,cron,enabled,nextFire,notify,goal}:\n  loop-1,Cookie,\"0 8 * * *\",on,—,auto,—";
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops" ? { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: toon, exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--fields", "notify,goal"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["loops", "--fields", "notify,goal"]);
  });

  test("--fields=… (equals form) is parsed and forwarded", async () => {
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops" ? { ok: true, body: { ok: true, loops: [], text: "count: 0\nloops: []", exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--fields=notify,goal"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["loops", "--fields", "notify,goal"]);
  });

  test("--json is forwarded and its (JSON) text printed verbatim (F4)", async () => {
    const json = JSON.stringify([{ id: "loop-1", name: "Cookie" }], null, 2);
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv.includes("--json") ? { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: json, exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--json"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["loops", "--json"]);
    expect(cap.stdout().trimStart()[0]).toBe("["); // real JSON, not TOON
  });

  test("an unknown flag on loops → exit 2, no fetch (F3)", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--bogusflag"], cap)).toBe(2);
    expect(cap.stderr()).toContain("unknown flag --bogusflag");
    expect(calls).toHaveLength(0);
  });

  test("old-server fallback honors --json locally (prints JSON from the structured loops)", async () => {
    const { fetchFn } = stub(({ url }) =>
      url.includes("/api/machine/cli") ? { ok: false, status: 404, body: {} } : { ok: true, body: { loops: [{ id: "loop-1", name: "Cookie", cron: "0 8 * * *", timezone: null, enabled: true, notify: "auto", nextRunAt: null }] } },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--json"], cap)).toBe(0);
    expect(cap.stdout().trimStart()[0]).toBe("[");
    expect(cap.stdout()).toContain('"id": "loop-1"');
  });
});

describe("runInteractive — edit no-op (F8) + input-required guard", () => {
  test("edit --json '{}' is forwarded (NOT short-circuited to usage), server reports the no-op", async () => {
    const toon = "nothing to change: Cookie (loop-1)\neditable[13]: name, cron, timezone";
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "edit" ? { ok: true, body: { ok: true, nothingToChange: true, text: toon, exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1", "--json", "{}"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["edit", "loop-1", "--json", "{}"]);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("edit <id> with NO input flags is still a usage error (exit 2, no fetch)", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1"], cap)).toBe(2);
    expect(cap.stderr()).toContain("usage");
    expect(calls).toHaveLength(0);
  });
});

describe("runInteractive — legacy fallback (old server 404s the unified dispatch)", () => {
  test("loops falls back to GET /api/machine/loop", async () => {
    const { fetchFn, calls } = stub(({ url }) =>
      url.includes("/api/machine/cli")
        ? { ok: false, status: 404, body: { error: "not found" } }
        : { ok: true, body: { loops: [{ id: "loop-1", name: "Cookie", cron: "0 8 * * *", timezone: null, enabled: false, notify: "smart", nextRunAt: null }] } },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops"], cap)).toBe(0);
    expect(calls[0]!.url).toContain("/api/machine/cli");
    expect(calls[1]!.url).toBe("https://srv.test/api/machine/loop");
    expect(calls[1]!.method).toBe("GET");
    expect(cap.stdout()).toContain("loop-1");
    expect(cap.stdout()).toContain("paused"); // enabled:false
  });

  test("edit falls back to PATCH /api/machine/loop with the {id, patch, dryRun} body", async () => {
    const { fetchFn, calls } = stub(({ url }) =>
      url.includes("/api/machine/cli")
        ? { ok: false, status: 404, body: { error: "not found" } }
        : { ok: true, body: { ok: true, name: "Cookie", applied: ["goal"] } },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1", "--json", '{"goal":"ship v1"}'], cap)).toBe(0);
    const patchCall = calls.find((c) => c.method === "PATCH")!;
    expect(patchCall.url).toBe("https://srv.test/api/machine/loop");
    expect(patchCall.parsedBody).toEqual({ id: "loop-1", patch: { goal: "ship v1" }, dryRun: false });
    expect(cap.stdout()).toContain("updated Cookie");
  });
});

describe("runInteractive — local guards (no fetch)", () => {
  test("not connected → exit 2 with a clear message, no fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn, server: "", token: undefined });
    expect(await runInteractive(["loops"], cap)).toBe(2);
    expect(cap.stderr()).toContain("isn't connected");
    expect(calls).toHaveLength(0);
  });

  test("edit with no id → usage, exit 2, no fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit"], cap)).toBe(2);
    expect(cap.stderr()).toContain("usage");
    expect(calls).toHaveLength(0);
  });

  test("an unknown interactive verb → exit 2", async () => {
    const { fetchFn } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["bogus"], cap)).toBe(2);
    expect(cap.stderr()).toContain("unknown command");
  });
});
