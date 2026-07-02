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

import { buildPatch, parseFlags } from "./interactive.js";

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
