import { describe, expect, it } from "vitest";
import { DOC_FORMATS, KIND_KEYS, parseDate, parseKindArtifact, serializeKindArtifact } from "./artifactSeam.js";

const NOW = new Date("2026-08-03T00:00:00.000Z");

describe("kind artifact seam", () => {
  it("keeps closed top-level key sets at the server, with payload as a free zone", () => {
    // `mirrors` is the one key here that is not a FIELD of the task: it is a
    // constructor argument, consumed at create and never stored on the row (see
    // `artifactSeam.MIRRORS_KEY`), which is why `show --file` never emits it.
    expect(KIND_KEYS.task).toEqual(["title", "key", "parent", "follow_up", "watcher", "needs_human", "payload", "mirrors"]);
    const result = parseKindArtifact("task", "---\ntitle: A\npayload:\n  anything:\n    goes: here\n---\nbody\n", NOW);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown key with deterministic did-you-mean teaching", () => {
    const result = parseKindArtifact("task", "---\nfollow_ups: +3d\n---\nbody\n", NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ code: "UNKNOWN_KEY", issues: [{ got: "follow_ups", expected: "follow_up" }] });
    expect(!result.ok && result.error.hint).toContain("payload:");
  });

  it("accepts only RFC3339-with-offset or +Nh/+Nd", () => {
    expect(parseDate("+3d", NOW)).toBe("2026-08-06T00:00:00.000Z");
    expect(parseDate("2026-08-06T08:00:00+08:00", NOW)).toBe("2026-08-06T00:00:00.000Z");
    for (const bad of ["tomorrow", "+2w", "+30m", "2026-08-06", "2026-08-06T08:00:00"]) expect(parseDate(bad, NOW)).toBeUndefined();
  });
});

/**
 * `parent:` — the hierarchy key (convergence S4). The seam checks SHAPE only:
 * whether the parent exists, is a task, is in this team and is outside this
 * task's subtree are facts only a transaction can know, and the kernel's
 * `parentIssue` guard knows them.
 */
describe("parent: is a task id, checked for shape and round-tripped", () => {
  it("reads a task id, and an absent key as a root", () => {
    const child = parseKindArtifact("task", "---\ntitle: step\nparent: task-7f3a91\n---\nbody\n", NOW);
    expect(child.ok && child.value.parentId).toBe("task-7f3a91");
    const root = parseKindArtifact("task", "---\ntitle: step\n---\nbody\n", NOW);
    expect(root.ok && root.value.parentId).toBe(null);
  });

  // The kind prefix IS the type, so a loop id here is caught before the write.
  it("refuses a parent that is not a task id", () => {
    const result = parseKindArtifact("task", "---\ntitle: step\nparent: loop-4c1d77\n---\nbody\n", NOW);
    expect(!result.ok && result.error.code).toBe("SCHEMA_VIOLATION");
    expect(!result.ok && result.error.issues).toMatchObject([{ path: "parent", expected: "task-<id>" }]);
  });

  it("is task-only: a doc or a loop that names one gets the key-set refusal", () => {
    for (const kind of ["doc", "loop"] as const) {
      const result = parseKindArtifact(kind, "---\ntitle: x\nparent: task-7f3a91\n---\nbody\n", NOW);
      expect(!result.ok && result.error.code).toBe("UNKNOWN_KEY");
    }
  });

  /** `show --file` must emit a file its own re-upload preserves — otherwise a
   *  whole-file update silently re-roots the task. */
  it("serializes into the canonical file, and omits it for a root", () => {
    const text = serializeKindArtifact("task", { title: "step", key: null, body: "b", payload: null, parentId: "task-7f3a91", watcher: "loop-4c1d77" });
    expect(text).toContain("parent: task-7f3a91");
    expect(parseKindArtifact("task", text, NOW)).toMatchObject({ ok: true, value: { parentId: "task-7f3a91" } });
    expect(serializeKindArtifact("task", { title: "step", key: null, body: "b", payload: null, parentId: null, watcher: "loop-4c1d77" })).not.toContain("parent:");
  });
});

describe("the closed key sets are per kind, and the kind firewalls are named", () => {
  it("keeps cron off a task and format off a task or loop", () => {
    const cron = parseKindArtifact("task", "---\ncron: 0 6 * * 1\n---\nbody\n", NOW);
    expect(!cron.ok && cron.error).toMatchObject({ code: "UNKNOWN_KEY", issues: [{ message: "a cadence belongs to a loop, not a task" }] });
    // `format` on a task is an UNKNOWN_KEY refusal, not a value refusal: it is
    // simply not in the task key set (CLI spec §6.4). The teaching still names
    // the composition rule for a rich body.
    const format = parseKindArtifact("task", "---\nformat: html\n---\nbody\n", NOW);
    expect(!format.ok && format.error.code).toBe("UNKNOWN_KEY");
    expect(!format.ok && format.error.hint).toContain("create a doc with format: html");
  });

  it("refuses kind: outright — the verb chooses the kind, never the front matter", () => {
    const result = parseKindArtifact("task", "---\nkind: doc\n---\nbody\n", NOW);
    expect(!result.ok && result.error).toMatchObject({ code: "UNKNOWN_KEY", issues: [{ message: "kind is chosen by the verb, never by front matter" }] });
  });

  it("holds a doc's format to the closed two-value set", () => {
    expect(DOC_FORMATS).toEqual(["markdown", "html"]);
    for (const good of DOC_FORMATS) {
      const ok = parseKindArtifact("doc", `---\nformat: ${good}\n---\nbody\n`, NOW);
      expect(ok.ok && ok.value.format).toBe(good);
    }
    const bad = parseKindArtifact("doc", "---\nformat: pdf\n---\nbody\n", NOW);
    expect(!bad.ok && bad.error).toMatchObject({ code: "UNSUPPORTED_FORMAT", issues: [{ got: "pdf", expected: "markdown" }] });
    expect(!bad.ok && bad.error.hint).toContain("markdown is the default");
  });

  it("derives an absent title from the body's first heading rather than refusing", () => {
    const result = parseKindArtifact("task", "---\nkey: k\n---\n# Observe PR #201\n\ntext\n", NOW);
    expect(result.ok && result.value.title).toBe("Observe PR #201");
  });

  it("normalizes a BOM and CRLF once, at the seam, so the stored form round-trips", () => {
    const result = parseKindArtifact("task", "﻿---\r\ntitle: A\r\n---\r\n\r\nline one\r\nline two\r\n", NOW);
    expect(result.ok && result.value.body).toBe("\nline one\nline two\n");
  });

  it("round-trips an object through serialize → parse without changing a field", () => {
    const file = serializeKindArtifact("task", { title: "Observe", key: "pr-201", body: "## What to watch\n", payload: { pr: 201 }, followUpAt: "2026-08-06T00:00:00.000Z", watcher: "loop-4c1d77", pendingQuestion: null });
    const back = parseKindArtifact("task", file, NOW);
    expect(back.ok && back.value).toMatchObject({ title: "Observe", key: "pr-201", watcher: "loop-4c1d77", followUpAt: "2026-08-06T00:00:00.000Z", payload: { pr: 201 } });
  });

  it("omits payload entirely when there is none, so an absent payload survives the round trip", () => {
    const file = serializeKindArtifact("loop", { title: "Housekeeper", key: "housekeeper", body: "charter\n", payload: null, cron: "0 7 * * *" });
    // `payload: {}` would re-parse to an empty mapping — a value, not an absence —
    // and every consumer diffing it against a null payload would report a change
    // the file never expressed (review F1).
    expect(file).not.toContain("payload");
    const back = parseKindArtifact("loop", file, NOW);
    expect(back.ok && back.value.payload).toBeNull();
  });

  it("carries a loop's BOUND workdir through the round trip", () => {
    // Captain ruling 2026-08-04: a loop binds a directory like the shipping
    // product does, so `workdir:` is a first-class loop key, not payload data.
    const file = serializeKindArtifact("loop", { title: "Housekeeper (local)", key: "hk-local", body: "charter\n", payload: null, cron: "0 7 * * *", workdir: "/Users/me/Workspace/repo" });
    expect(file).toContain("workdir: /Users/me/Workspace/repo");
    const back = parseKindArtifact("loop", file, NOW);
    expect(back.ok && back.value.workdir).toBe("/Users/me/Workspace/repo");
  });

  it("omits an absent workdir, so an unbound loop round-trips unbound", () => {
    const file = serializeKindArtifact("loop", { title: "Nomad", key: "nomad", body: "charter\n", payload: null, cron: "0 7 * * *", workdir: null });
    expect(file).not.toContain("workdir");
    const back = parseKindArtifact("loop", file, NOW);
    expect(back.ok && back.value.workdir).toBeNull();
  });

  it("refuses a relative workdir, because the claiming machine is unknown at write time", () => {
    const rel = parseKindArtifact("loop", "---\nworkdir: ./repo\n---\ncharter\n", NOW);
    expect(!rel.ok && rel.error).toMatchObject({ code: "SCHEMA_VIOLATION", issues: [{ path: "workdir", message: "must be an absolute path" }] });
    const tilde = parseKindArtifact("loop", "---\nworkdir: ~/repo\n---\ncharter\n", NOW);
    expect(!tilde.ok && tilde.error.code).toBe("SCHEMA_VIOLATION");
  });

  it("keeps workdir off a task and a doc — only a loop has an execution site", () => {
    for (const kind of ["task", "doc"] as const) {
      const result = parseKindArtifact(kind, "---\nworkdir: /Users/me/repo\n---\nbody\n", NOW);
      expect(!result.ok && result.error).toMatchObject({ code: "UNKNOWN_KEY", issues: [{ message: `a bound working directory belongs to a loop, not a ${kind}` }] });
    }
  });

  it("keeps an explicitly empty payload, because that is a value the file did express", () => {
    const file = serializeKindArtifact("doc", { title: "Note", key: "note", body: "text\n", payload: {}, format: "markdown" });
    expect(file).toContain("payload");
    const back = parseKindArtifact("doc", file, NOW);
    expect(back.ok && back.value.payload).toEqual({});
  });
});

