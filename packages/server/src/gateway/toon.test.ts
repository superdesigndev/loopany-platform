import { expect, test } from "vitest";

import {
  ABSENT,
  codeForStatus,
  countLine,
  detailBlock,
  doc,
  emptyList,
  errorBlock,
  helpBlock,
  inlineArray,
  kvLine,
  listBlock,
  needsQuote,
  quote,
  scalar,
  truncate,
} from "./toon.js";

// ---- scalar rendering + quoting ----

test("scalar renders numbers/booleans bare and null/undefined as the em-dash", () => {
  expect(scalar(70)).toBe("70");
  expect(scalar(0)).toBe("0");
  expect(scalar(true)).toBe("true");
  expect(scalar(false)).toBe("false");
  expect(scalar(null)).toBe(ABSENT);
  expect(scalar(undefined)).toBe(ABSENT);
  // A non-finite number degrades to the placeholder rather than "Infinity"/"NaN".
  expect(scalar(Infinity)).toBe(ABSENT);
  expect(scalar(NaN)).toBe(ABSENT);
});

test("scalar leaves a bare token unquoted, quotes anything with whitespace/comma/colon/quote or empty", () => {
  // Bare single tokens (matches gh-axi's `state: open`, `author: stonexer`).
  expect(scalar("open")).toBe("open");
  expect(scalar("ok/nothing-new")).toBe("ok/nothing-new");
  expect(scalar("$0.08")).toBe("$0.08");
  expect(scalar("loop-mr9aey5u-8854eece")).toBe("loop-mr9aey5u-8854eece");
  // Whitespace → quoted (a cron / a date read as one cell).
  expect(scalar("0 6 * * 1")).toBe('"0 6 * * 1"');
  expect(scalar("2026-07-13 06:00")).toBe('"2026-07-13 06:00"');
  // Comma / colon → quoted (would otherwise split a row / a kv line).
  expect(scalar("drift=3,prs=1")).toBe('"drift=3,prs=1"');
  expect(scalar("America/Los_Angeles")).toBe("America/Los_Angeles"); // slash is safe
  expect(scalar("a: b")).toBe('"a: b"');
  // Empty string → quoted (never a blank cell).
  expect(scalar("")).toBe('""');
});

test("needsQuote is the underlying predicate", () => {
  expect(needsQuote("open")).toBe(false);
  expect(needsQuote("has space")).toBe(true);
  expect(needsQuote("")).toBe(true);
  expect(needsQuote("a,b")).toBe(true);
});

test("quote escapes embedded quotes and newlines onto one line", () => {
  expect(quote('say "hi"')).toBe('"say \\"hi\\""');
  expect(quote("line1\nline2")).toBe('"line1\\nline2"');
  expect(quote("back\\slash")).toBe('"back\\\\slash"');
});

// ---- detail block ----

test("detailBlock renders a top key with indented key: value rows", () => {
  const out = detailBlock("loop", [
    ["name", "Docs Sweep"],
    ["cron", "0 6 * * 1"],
    ["enabled", true],
    ["goal", null],
  ]);
  expect(out).toBe(['loop:', '  name: "Docs Sweep"', '  cron: "0 6 * * 1"', "  enabled: true", `  goal: ${ABSENT}`].join("\n"));
});

test("detailBlock passes a { raw } value through verbatim (pre-rendered size hints)", () => {
  const out = detailBlock("loop", [["ui", { raw: "present, 2847 bytes — use --full to see" }]]);
  expect(out).toBe("loop:\n  ui: present, 2847 bytes — use --full to see");
});

// ---- count / list / empty ----

test("countLine covers the three aggregate flavors", () => {
  expect(countLine(3)).toBe("count: 3");
  expect(countLine(30, { showing: 30 })).toBe("count: 30 (showing first 30)");
  expect(countLine(3, { total: 12 })).toBe("count: 3 of 12 total");
});

test("listBlock emits a typed header and comma rows, quoting only where needed", () => {
  const out = listBlock(
    "loops",
    ["id", "name", "cron", "enabled"],
    [
      ["loop-abc", "Docs Sweep", "0 6 * * 1", "on"],
      ["loop-def", "Ship v1", "0 9 * * *", "paused"],
    ],
  );
  expect(out).toBe(
    [
      "loops[2]{id,name,cron,enabled}:",
      '  loop-abc,"Docs Sweep","0 6 * * 1",on',
      '  loop-def,"Ship v1","0 9 * * *",paused',
    ].join("\n"),
  );
});

test("listBlock with no rows still counts zero in the header", () => {
  expect(listBlock("runs", ["ts", "role"], [])).toBe("runs[0]{ts,role}:");
});

test("emptyList + countLine(0) is the definitive empty state", () => {
  expect(doc(countLine(0), emptyList("loops"))).toBe("count: 0\nloops: []");
});

// ---- inline array ----

test("inlineArray joins scalar items on one line with the given separator", () => {
  expect(inlineArray("applied", ["cron", "goal"])).toBe("applied[2]: cron, goal");
  expect(inlineArray("nextRuns", ["2026-07-13 06:00", "2026-07-20 06:00"], " · ")).toBe(
    'nextRuns[2]: "2026-07-13 06:00" · "2026-07-20 06:00"',
  );
});

// ---- help ----

test("helpBlock renders help[N]: with indented command templates verbatim", () => {
  const out = helpBlock(["Run `loopany show <id>` to see a loop's full config", "Run `loopany log <id>` to see recent runs"]);
  expect(out).toBe(
    [
      "help[2]:",
      "  Run `loopany show <id>` to see a loop's full config",
      "  Run `loopany log <id>` to see recent runs",
    ].join("\n"),
  );
});

// ---- errors ----

test("errorBlock quotes the message and emits a bare code slug", () => {
  expect(errorBlock('status must be new|resolved|nothing-new (got "wibble")', "VALIDATION_ERROR")).toBe(
    'error: "status must be new|resolved|nothing-new (got \\"wibble\\")"\ncode: VALIDATION_ERROR',
  );
});

test("codeForStatus maps HTTP statuses to axi slugs", () => {
  expect(codeForStatus(400)).toBe("VALIDATION_ERROR");
  expect(codeForStatus(401)).toBe("UNAUTHORIZED");
  expect(codeForStatus(403)).toBe("FORBIDDEN");
  expect(codeForStatus(404)).toBe("NOT_FOUND");
  expect(codeForStatus(409)).toBe("CONFLICT");
  expect(codeForStatus(429)).toBe("RATE_LIMITED");
  expect(codeForStatus(500)).toBe("ERROR");
});

// ---- truncation ----

test("truncate leaves a short string untouched and clips a long one with a size hint", () => {
  expect(truncate("short", 100)).toEqual({ value: "short", truncated: false });

  const long = "x".repeat(250);
  const r = truncate(long, 180);
  expect(r.truncated).toBe(true);
  expect(r.value.startsWith("x".repeat(180))).toBe(true);
  expect(r.value).toContain("(truncated, 250 chars total — use --full to see complete body)");
});

test("truncate accepts a terse tail for dense list cells", () => {
  const r = truncate("y".repeat(50), 10, "use --full");
  expect(r.value).toBe("yyyyyyyyyy (truncated, 50 chars total — use --full)");
});

test("truncate boundary: exactly cap chars is not truncated", () => {
  expect(truncate("abcde", 5)).toEqual({ value: "abcde", truncated: false });
  expect(truncate("abcdef", 5).truncated).toBe(true);
});

// ---- doc joiner ----

test("doc joins non-empty sections and drops falsy/blank ones", () => {
  expect(doc("a", "", null, undefined, false, "b")).toBe("a\nb");
  expect(doc(countLine(2), listBlock("x", ["k"], [["v"]]), false && "skip")).toBe("count: 2\nx[1]{k}:\n  v");
});
