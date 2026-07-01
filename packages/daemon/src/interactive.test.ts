/**
 * `buildPatch` / `parseFlags` — the `loopany edit` patch assembly. Proves the
 * envelope flags, the convenience `--*-file` content flags, and an explicit
 * `--json` / `--json-file` object all fold into one body with the documented
 * precedence (explicit JSON keys win). The server is the sole validator, so
 * these tests only assert the SHAPE the daemon sends.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { buildPatch, parseFlags } from "./interactive.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "loopany-edit-"));

describe("buildPatch", () => {
  test("maps envelope flags to server patch keys", () => {
    const { flags } = parseFlags(["--cron", "0 9 * * *", "--tz", "UTC", "--task-file", "/x/README.md"]);
    expect(buildPatch(flags)).toEqual({ cron: "0 9 * * *", timezone: "UTC", taskFile: "/x/README.md" });
  });

  test("--pause/--resume/--allow-control shape the enabled/allowControl fields", () => {
    expect(buildPatch(parseFlags(["--pause"]).flags)).toEqual({ enabled: false });
    expect(buildPatch(parseFlags(["--resume"]).flags)).toEqual({ enabled: true });
    expect(buildPatch(parseFlags(["--allow-control", "true"]).flags)).toEqual({ allowControl: true });
    expect(buildPatch(parseFlags(["--allow-control", "false"]).flags)).toEqual({ allowControl: false });
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

  test("--json object merges and its keys win over flag-derived values", () => {
    const { flags } = parseFlags(["--cron", "0 9 * * *", "--json", '{"cron":"*/5 * * * *","name":"nightly"}']);
    expect(buildPatch(flags)).toEqual({ cron: "*/5 * * * *", name: "nightly" });
  });

  test("--json-file reads and merges an object", () => {
    const dir = tmp();
    const jf = path.join(dir, "patch.json");
    writeFileSync(jf, '{"model":"opus","notify":"always"}');
    const { flags } = parseFlags(["--json-file", jf]);
    expect(buildPatch(flags)).toEqual({ model: "opus", notify: "always" });
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
