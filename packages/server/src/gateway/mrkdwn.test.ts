import { expect, test } from "vitest";
import { markdownToMrkdwn } from "./mrkdwn";

test("converts bold", () => {
  expect(markdownToMrkdwn("this is **bold** text")).toBe("this is *bold* text");
});

test("converts a link", () => {
  expect(markdownToMrkdwn("see [the docs](https://example.com/docs)")).toBe(
    "see <https://example.com/docs|the docs>",
  );
});

test("converts strikethrough", () => {
  expect(markdownToMrkdwn("~~old~~ new")).toBe("~old~ new");
});

test("converts a heading to a bold line", () => {
  expect(markdownToMrkdwn("## Section title\nbody")).toBe("*Section title*\nbody");
});

test("protects a fenced code block from conversion", () => {
  const input = "before\n```\nconst x = **not bold**\n```\nafter";
  const out = markdownToMrkdwn(input);
  expect(out).toBe(input); // untouched — the code fence round-trips verbatim
});

test("protects inline code from conversion", () => {
  expect(markdownToMrkdwn("run `**not bold**` now")).toBe("run `**not bold**` now");
});

test("wraps a markdown table in a code fence and drops the divider row", () => {
  const input = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const out = markdownToMrkdwn(input);
  expect(out).toBe("```\n| a | b |\n| 1 | 2 |\n```");
});

test("passes plain text through unchanged", () => {
  expect(markdownToMrkdwn("just a plain sentence.")).toBe("just a plain sentence.");
});
