/**
 * Strict workspace load: a hand-edited / truncated / duplicated file is a
 * RENDERED DriverError past the CLI's error boundary, never an uncaught throw or
 * a silent last-writer-wins. The reviewer's corruption table (C7 + C8):
 *   id ≠ filename            -> CORRUPT_OBJECT
 *   duplicate object id      -> CORRUPT_OBJECT
 *   corrupt triggers/*.json  -> CORRUPT_TRIGGER
 *   corrupt runs/*.json      -> CORRUPT_RUN
 *   corrupt events/*.jsonl   -> CORRUPT_EVENT
 * (C6 — out-of-enum status — is proven at the objectFile seam in
 * objectFile.test.ts; here we prove the driver surfaces its CodecError.)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";

describe("strict workspace load (corruption table)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-corrupt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // registryHome/probe isolate `init`'s registry write + PATH seed (test hazard).
  const deps = (): CliDeps => ({ cwd: dir, now: "2026-08-09T12:00:00.000Z", env: {}, registryHome: dir, probe: () => false });
  const call = (argv: string[]) => run(argv, deps());
  const ws = () => join(dir, ".loopany");

  const seedLoop = () => {
    call(["init"]);
    // a task + its cron trigger + an event stream, so triggers/runs/events exist
    call(["create", "Nightly", "--cron", "0 7 * * *", "--assignee", "claude"]);
    call(["note", "nightly", "hello"]);
  };

  it("C6: an out-of-enum status surfaces as a rendered CORRUPT_OBJECT error", () => {
    seedLoop();
    const path = join(ws(), "objects", "nightly.md");
    const text = readFileSync(path, "utf8").replace(/status: \w[\w-]*/, "status: banana");
    writeFileSync(path, text);
    const out = call(["show", "nightly"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_OBJECT");
    expect(out.stderr).toContain("not a valid status");
  });

  it("C7: an id that disagrees with the filename is CORRUPT_OBJECT", () => {
    call(["init"]);
    call(["create", "Task A", "--id", "task-a"]);
    const path = join(ws(), "objects", "task-a.md");
    const text = readFileSync(path, "utf8").replace("id: task-a", "id: renamed");
    writeFileSync(path, text);
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_OBJECT");
    expect(out.stderr).toContain("does not match filename");
  });

  it("C7: a second file carrying an existing id (last-writer-wins attempt) is rejected", () => {
    call(["init"]);
    call(["create", "Original", "--id", "dup"]);
    // A copy under a DIFFERENT filename but the same internal id — the silent
    // last-writer-wins corruption the probe demonstrated. The id≠filename guard
    // (the file's id must equal its basename) catches it before it can shadow
    // the original in the snapshot index.
    const original = readFileSync(join(ws(), "objects", "dup.md"), "utf8");
    writeFileSync(join(ws(), "objects", "clone.md"), original.replace("title: Original", "title: Clone"));
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_OBJECT");
    expect(out.stderr).toContain("does not match filename");
  });

  it("C8: a corrupt triggers/*.json is CORRUPT_TRIGGER, not an uncaught SyntaxError", () => {
    seedLoop();
    writeFileSync(join(ws(), "triggers", "trg-nightly-cron.json"), "{ not valid json ");
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_TRIGGER");
  });

  it("C8: a corrupt runs/*.json is CORRUPT_RUN", () => {
    seedLoop();
    writeFileSync(join(ws(), "runs", "r-bogus.json"), "}{");
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_RUN");
  });

  // C8 (valid-JSON corruption): a file that parses cleanly but is the WRONG
  // SHAPE must still be a rendered CORRUPT_* error, not fed to a downstream
  // renderer (which dereferences t.taskId) or the M3 tick (which reads run.state).
  it("C8: a valid-JSON trigger that is `null` is CORRUPT_TRIGGER, not a crash", () => {
    seedLoop();
    writeFileSync(join(ws(), "triggers", "trg-nightly-cron.json"), "null");
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_TRIGGER");
    // and `show` (which dereferences the trigger) does not crash either
    const show = call(["show", "nightly"]);
    expect(show.exitCode).toBe(1);
    expect(show.stderr).toContain("code: CORRUPT_TRIGGER");
  });

  it("C8: a valid-JSON run that is `{}` (missing fields) is CORRUPT_RUN", () => {
    seedLoop();
    writeFileSync(join(ws(), "runs", "r-empty.json"), "{}");
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_RUN");
  });

  it("C8: a trigger with an out-of-enum kind is CORRUPT_TRIGGER", () => {
    seedLoop();
    const path = join(ws(), "triggers", "trg-nightly-cron.json");
    const trig = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    trig.kind = "banana";
    writeFileSync(path, JSON.stringify(trig));
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_TRIGGER");
  });

  it("C8: a run with an out-of-enum state is CORRUPT_RUN", () => {
    seedLoop();
    const validRun = {
      id: "r-1",
      taskId: "nightly",
      cause: "cron",
      scheduledAt: "2026-08-09T07:00:00.000Z",
      state: "gremlin",
      assignee: "claude",
      triggerId: "trg-nightly-cron",
      createdAt: "2026-08-09T07:00:00.000Z",
    };
    writeFileSync(join(ws(), "runs", "r-1.json"), JSON.stringify(validRun));
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_RUN");
  });

  it("C8: a corrupt events/*.jsonl is CORRUPT_EVENT with a line number", () => {
    seedLoop();
    const path = join(ws(), "events", "nightly.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + "{ broken line\n");
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
    expect(out.stderr).toMatch(/line \d+/);
  });

  // C8 (valid-JSON event corruption): a line that parses cleanly but is the
  // WRONG SHAPE must be a rendered CORRUPT_EVENT, never a raw TypeError from the
  // `--log` renderer dereferencing e.provenance.entrance.
  it("C8: a valid-JSON event line that is `null` is CORRUPT_EVENT, not a crash", () => {
    seedLoop();
    const path = join(ws(), "events", "nightly.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + "null\n");
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
  });

  it("C8: a valid-JSON event line that is `{}` (missing fields) is CORRUPT_EVENT", () => {
    seedLoop();
    const path = join(ws(), "events", "nightly.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + "{}\n");
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
  });

  it("C8: an event line with a bad `provenance` is CORRUPT_EVENT", () => {
    seedLoop();
    const path = join(ws(), "events", "nightly.jsonl");
    const bad = JSON.stringify({
      id: "e-bad",
      objectId: "nightly",
      kind: "note",
      at: "2026-08-09T12:00:00.000Z",
      provenance: { entrance: "banana", actorId: "cli" },
    });
    writeFileSync(path, readFileSync(path, "utf8") + bad + "\n");
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
  });

  // C8 (malformed-but-valid-JSON event): the OPTIONAL renderer inputs must be
  // type-checked. Each of these parses cleanly yet crashes the `--log` renderer
  // (clip's `.replace`, summarizeDiff's `.old`, or the sessionId interpolation)
  // with a raw TypeError that would ESCAPE run()'s DriverError boundary — the
  // very thing the guard exists to prevent.
  const appendEvent = (extra: Record<string, unknown>): void => {
    const path = join(ws(), "events", "nightly.jsonl");
    const line = JSON.stringify({
      id: "e-mal",
      objectId: "nightly",
      kind: "note",
      at: "2026-08-09T12:00:00.000Z",
      provenance: { entrance: "human", actorId: "cli" },
      ...extra,
    });
    writeFileSync(path, readFileSync(path, "utf8") + line + "\n");
  };

  it("C8: a numeric `note` is CORRUPT_EVENT, not a TypeError from clip.replace", () => {
    seedLoop();
    appendEvent({ note: 42 });
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
  });

  it("C8: a null-valued `diff` entry is CORRUPT_EVENT, not a TypeError from summarizeDiff", () => {
    seedLoop();
    appendEvent({ diff: { status: null } });
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
  });

  it("C8: a non-string `sessionId` is CORRUPT_EVENT", () => {
    seedLoop();
    appendEvent({ provenance: { entrance: "human", actorId: "cli", sessionId: 99 } });
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
  });

  // C7 for the event stream: an event whose `objectId` names a DIFFERENT object
  // (cross-stream) was mis-filed and would render in the wrong task's `--log`.
  // The events file is the append-only audit record (§3), so id==basename holds
  // here too — a cross-stream line is CORRUPT_EVENT.
  it("C7: a cross-stream event (objectId != stream filename) is CORRUPT_EVENT", () => {
    seedLoop();
    // Seed a second task so "task-b" is a real object, and place a task-b event
    // into task-a's (nightly's) stream — before the fix it rendered in nightly's
    // history.
    call(["create", "Other", "--id", "task-b"]);
    const path = join(ws(), "events", "nightly.jsonl");
    const bad = JSON.stringify({
      id: "e-crossed",
      objectId: "task-b",
      kind: "note",
      at: "2026-08-09T12:00:00.000Z",
      provenance: { entrance: "human", actorId: "cli" },
    });
    writeFileSync(path, readFileSync(path, "utf8") + bad + "\n");
    const out = call(["show", "nightly", "--log"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_EVENT");
    expect(out.stderr).toContain("does not match the stream");
  });

  // C7 for the JSON tables: a copied file carrying an EXISTING trigger/run id
  // (id != its new basename) loads silently and renders the record twice. The
  // id==basename guard, extended to triggers/ and runs/, catches it.
  it("C7: a copied triggers/*.json carrying an existing id is CORRUPT_TRIGGER", () => {
    seedLoop();
    const original = readFileSync(join(ws(), "triggers", "trg-nightly-cron.json"), "utf8");
    // A second file under a DIFFERENT basename but the same internal id.
    writeFileSync(join(ws(), "triggers", "copy.json"), original);
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_TRIGGER");
    expect(out.stderr).toContain("does not match filename");
  });

  it("C7: a copied runs/*.json carrying an existing id is CORRUPT_RUN", () => {
    seedLoop();
    const validRun = {
      id: "r-real",
      taskId: "nightly",
      cause: "cron",
      scheduledAt: "2026-08-09T07:00:00.000Z",
      state: "pending",
      assignee: "claude",
      triggerId: "trg-nightly-cron",
      createdAt: "2026-08-09T07:00:00.000Z",
    };
    writeFileSync(join(ws(), "runs", "r-real.json"), JSON.stringify(validRun));
    // A copy under a different basename but the same internal id.
    writeFileSync(join(ws(), "runs", "copy.json"), JSON.stringify(validRun));
    const out = call(["list"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("code: CORRUPT_RUN");
    expect(out.stderr).toContain("does not match filename");
  });
});
