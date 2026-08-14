import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArtifactRef } from "./ObjectRefs";

describe("ArtifactRef", () => {
  it("allows a long mirror URL to wrap inside the detail pane", () => {
    const url = "https://app.intercom.com/a/inbox/ut8rqlto/inbox/shared/all/conversation/215475476866861";
    const html = renderToStaticMarkup(createElement(ArtifactRef, {
      entry: {
        archetype: "mirror",
        id: "m-3a2f2d3f8ccc",
        kind: "url",
        coords: url,
      },
      select: vi.fn(),
    }));

    expect(html).toContain(url);
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
