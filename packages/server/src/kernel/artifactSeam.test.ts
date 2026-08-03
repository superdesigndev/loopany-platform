import { describe, expect, it } from "vitest";
import { DOC_FORMATS, KIND_KEYS, parseDate, parseKindArtifact, serializeKindArtifact } from "./artifactSeam.js";

const NOW = new Date("2026-08-03T00:00:00.000Z");

describe("kind artifact seam", () => {
  it("keeps closed top-level key sets at the server, with payload as a free zone", () => {
    expect(KIND_KEYS.task).toEqual(["title", "key", "follow_up", "watcher", "needs_human", "payload"]);
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
});

