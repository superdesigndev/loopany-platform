import { describe, expect, it } from "vitest";
import { parseArtifact } from "./parse.js";
import { renderArtifactBody, renderMarkdown } from "./render.js";

/** The only tags a rendered artifact body may contain. */
const RENDERABLE_TAGS = new Set([
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del",
  "blockquote", "ul", "ol", "li",
  "pre", "code", "a", "img",
  "table", "thead", "tbody", "tr", "th", "td", "input",
]);

/**
 * Every rendered output must be inert MARKUP, whatever the input was.
 *
 * The check is deliberately tag-aware rather than a substring scan: escaped
 * text may legitimately CONTAIN the string `javascript:` or `onerror=` (that is
 * exactly what escaping raw HTML looks like). What must never exist is a live
 * tag or attribute carrying it.
 */
function expectInert(html: string): void {
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
    expect(name, `not a recognizable tag: ${tag}`).toBeDefined();
    expect([...RENDERABLE_TAGS], `unexpected tag: ${tag}`).toContain(name);
    expect(tag, `event handler: ${tag}`).not.toMatch(/\son[a-z]+\s*=/i);
    expect(tag, `inline style: ${tag}`).not.toMatch(/\sstyle\s*=/i);
    expect(tag, `presentational attribute: ${tag}`).not.toMatch(/\salign\s*=/i);
    for (const [, url] of tag.matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"/gi)) {
      expect(url, `unsafe scheme: ${tag}`).not.toMatch(/^\s*(javascript|data|vbscript|file):/i);
      expect(url, `protocol-relative url: ${tag}`).not.toMatch(/^\s*\/\//);
    }
  }
  expect(html, "an HTML comment survived").not.toContain("<!--");
}

describe("markdown rendering", () => {
  it("renders semantic HTML with no styling", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and *italic* and ~~struck~~ text.\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>struck</del>");
    expectInert(html);
  });

  it("renders GFM tables, carrying alignment as data rather than presentation", () => {
    const html = renderMarkdown(["| left | right |", "|:-----|------:|", "| a    | b     |"].join("\n"));
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain('<th data-align="left">left</th>');
    expect(html).toContain('<td data-align="right">b</td>');
    expectInert(html);
  });

  it("renders fenced code blocks with a language hint and escaped contents", () => {
    const html = renderMarkdown('```ts\nconst x = "<script>alert(1)</script>";\n```\n');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("&lt;script&gt;");
    expectInert(html);
  });

  it("renders lists, task lists, blockquotes and links", () => {
    const html = renderMarkdown(
      ["- [ ] todo", "- [x] done", "", "> quoted", "", "3. three", "4. four", "", "[docs](https://example.com)"].join(
        "\n",
      ),
    );
    expect(html).toContain('<input type="checkbox" disabled="disabled" />');
    expect(html).toContain('<input type="checkbox" disabled="disabled" checked="checked" />');
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expectInert(html);
  });

  it("keeps images on http(s) and drops other image sources", () => {
    const ok = renderMarkdown("![alt](https://example.com/a.png)");
    expect(ok).toContain('src="https://example.com/a.png"');
    expect(ok).toContain('alt="alt"');

    const bad = renderMarkdown("![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)");
    expect(bad).not.toContain("src=");
    expectInert(bad);

    expect(renderMarkdown("![alt](https://example.com/a.png)", { allowImages: false })).not.toContain("<img");
  });
});

describe("hostile bodies", () => {
  it("neutralizes a script tag", () => {
    const html = renderMarkdown("before\n\n<script>alert(document.cookie)</script>\n\nafter");
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).toContain("&lt;script&gt;");
    expectInert(html);
  });

  it("neutralizes a raw HTML block", () => {
    const html = renderMarkdown(
      ['<div class="x" style="color:red">', '  <a href="javascript:alert(1)">click</a>', "</div>"].join("\n"),
    );
    expect(html).not.toContain("<div");
    expectInert(html);
  });

  it("neutralizes inline raw HTML and event handlers", () => {
    const html = renderMarkdown('text <img src=x onerror="alert(1)"> more <b onclick="x()">b</b>');
    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/<b[ >]/);
    expectInert(html);
  });

  it("drops a javascript: link target but keeps the text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).toContain("click me");
    expect(html).not.toContain("href=");
    expectInert(html);
  });

  it("drops a data: link target", () => {
    const html = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)");
    expect(html).not.toContain("href=");
    expectInert(html);
  });

  it("drops obfuscated and protocol-relative URLs", () => {
    for (const url of ["JaVaScRiPt:alert(1)", "java&#9;script:alert(1)", "//evil.example.com/x", " javascript:alert(1)"]) {
      const html = renderMarkdown(`[x](${url})`);
      expect(html, `href survived for ${url}`).not.toContain("href=");
      expectInert(html);
    }
  });

  it("neutralizes an svg/foreignObject payload", () => {
    const html = renderMarkdown('<svg><foreignObject><script>alert(1)</script></foreignObject></svg>');
    expect(html).not.toMatch(/<svg/i);
    expectInert(html);
  });

  it("neutralizes an iframe, a form and a style block", () => {
    const html = renderMarkdown(
      [
        '<iframe src="https://evil.example.com"></iframe>',
        "",
        '<form action="/x"><input name="p" type="password"></form>',
        "",
        "<style>body{display:none}</style>",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<form/i);
    // A `<input>` arriving as raw HTML is escaped, never a live control.
    expect(html).not.toMatch(/<input[^>]*type="password"/i);
    expectInert(html);
  });

  it("strips raw HTML entirely in strip mode", () => {
    const html = renderMarkdown("keep me\n\n<script>alert(1)</script>\n\n<div>and me?</div>", {
      rawHtml: "strip",
    });
    expect(html).toContain("keep me");
    expect(html).not.toContain("&lt;script&gt;");
    expect(html).not.toContain("alert(1)");
    expectInert(html);
  });

  it("drops HTML comments", () => {
    expect(renderMarkdown("a\n\n<!-- secret -->\n\nb", { rawHtml: "strip" })).not.toContain("secret");
  });

  it("survives an autolink and a mailto", () => {
    const html = renderMarkdown("<https://example.com> and <mailto:a@example.com>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:a@example.com"');
    expectInert(html);
  });

  it("renders an empty body to an empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });
});

describe("renderArtifactBody", () => {
  it("renders a parsed document's body", () => {
    const doc = parseArtifact("---\ntype: note\nformat: markdown\n---\n\n# Hi\n");
    expect(renderArtifactBody(doc)).toContain("<h1>Hi</h1>");
  });

  it("never renders the front matter", () => {
    const doc = parseArtifact("---\ntype: note\ntitle: Secret head\n---\n\nbody\n");
    expect(renderArtifactBody(doc)).not.toContain("Secret head");
  });

  it("refuses a body format it cannot render", () => {
    // The parser rejects an unknown `format:`, so this can only be reached by a
    // hand-built document — and it is still refused rather than guessed at.
    const doc = { frontMatter: { type: "note", format: "html" as never }, body: "<b>x</b>" };
    expect(() => renderArtifactBody(doc)).toThrow(/cannot render body format/);
  });
});
