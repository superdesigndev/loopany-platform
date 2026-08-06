import { describe, expect, it } from "vitest";
import { charterResponse, expectedCharterVersion } from "./api.loops.$loopId.charter.js";

const charter = {
  id: "doc-charter",
  loopId: "loop-one",
  key: "loop-charter:loop-one",
  docKind: "charter" as const,
  format: "markdown" as const,
  body: "# Charter\n",
  version: 42,
  updatedAt: "2026-08-06T00:00:00.000Z",
};

describe("charter HTTP preconditions and representation", () => {
  it("round-trips the event seq as ETag for JSON and Markdown", async () => {
    const json = charterResponse(charter, "application/json");
    expect(json.headers.get("etag")).toBe('"42"');
    expect(await json.json()).toEqual({ charter });
    const markdown = charterResponse(charter, "text/markdown");
    expect(markdown.headers.get("etag")).toBe('"42"');
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toBe("# Charter\n");
  });

  it("accepts only a quoted integer If-Match", () => {
    expect(expectedCharterVersion(new Request("https://loopany.test", { headers: { "if-match": '"42"' } }))).toBe(42);
    expect(expectedCharterVersion(new Request("https://loopany.test", { headers: { "if-match": 'W/"42"' } }))).toBe(42);
    expect(expectedCharterVersion(new Request("https://loopany.test", { headers: { "if-match": "42" } }))).toBeUndefined();
    expect(expectedCharterVersion(new Request("https://loopany.test"))).toBeUndefined();
  });
});
