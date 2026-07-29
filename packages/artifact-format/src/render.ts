/**
 * Rendering is a PROJECTION, never the source of truth: Markdown body →
 * sanitized, style-free semantic HTML. The product supplies the CSS; this
 * module emits no `style`, no `class` (except a code block's `language-*`
 * hint), and no presentational attributes.
 *
 * Two independent defenses against injection, on purpose:
 *   1. Raw HTML never reaches the HTML layer at all — the Markdown renderer
 *      escapes (default) or drops it, so `<script>` is text, not a tag.
 *   2. Whatever the Markdown renderer emits is then filtered through a strict
 *      allowlist (tags, attributes, URL schemes) by `sanitize-html`.
 * Either one alone would do; both means a change in either dependency's
 * behavior cannot silently open a hole.
 */

import { Marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { ArtifactFormatError } from "./errors.js";
import { bodyFormatOf } from "./schema.js";
import type { ArtifactDocument } from "./types.js";

export interface RenderOptions {
  /**
   * What to do with raw HTML found in the Markdown body.
   * - `escape` (default): render it as literal text — lossless and visible.
   * - `strip`: drop it. Use for bodies harvested from the outside world where
   *   stray markup is noise rather than authored content.
   */
  rawHtml?: "escape" | "strip";
  /** Set false to drop images entirely (e.g. a no-remote-content surface). */
  allowImages?: boolean;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

/** Exactly the tags the Markdown renderer can produce. Anything else — which
 *  in practice means anything that arrived as raw HTML — is not markup. */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "input",
];

const CELL_ALIGNMENTS = new Set(["left", "center", "right"]);

/** GFM column alignment is authored intent, but `align=` is a presentational
 *  attribute. Carry it as DATA so product CSS can select on it. */
function alignToData(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const align = attribs["align"];
  const out: sanitizeHtml.Attributes = { ...attribs };
  delete out["align"];
  if (typeof align === "string" && CELL_ALIGNMENTS.has(align)) out["data-align"] = align;
  return { tagName, attribs: out };
}

function sanitizerOptions(allowImages: boolean): sanitizeHtml.IOptions {
  return {
    allowedTags: allowImages ? ALLOWED_TAGS : ALLOWED_TAGS.filter((t) => t !== "img"),
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"],
      code: ["class"],
      ol: ["start"],
      th: ["colspan", "rowspan", "data-align"],
      td: ["colspan", "rowspan", "data-align"],
      input: ["type", "checked", "disabled"],
    },
    // Only a syntax-highlight hint survives; no styling classes.
    allowedClasses: { code: ["language-*"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    // `discard` keeps the text of an unknown tag; `nonTextTags` says which
    // tags take their CONTENT with them when they go.
    disallowedTagsMode: "discard",
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "noscript",
      "iframe",
      "object",
      "embed",
      "template",
      "title",
      "head",
    ],
    transformTags: {
      // A GFM task-list checkbox is semantic; force it inert regardless of what
      // attributes arrived.
      input: (_tagName, attribs) => ({
        tagName: "input",
        attribs: {
          type: "checkbox",
          disabled: "disabled",
          ...(attribs["checked"] !== undefined ? { checked: "checked" } : {}),
        },
      }),
      th: alignToData,
      td: alignToData,
    },
  };
}

function markedFor(rawHtml: "escape" | "strip"): Marked {
  const instance = new Marked({ gfm: true, breaks: false, pedantic: false, async: false });
  instance.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string {
        if (rawHtml === "strip") return "";
        const escaped = escapeHtml(token.text);
        return token.block ? `<p>${escaped}</p>\n` : escaped;
      },
    },
  });
  return instance;
}

const RENDERERS: Record<"escape" | "strip", Marked> = {
  escape: markedFor("escape"),
  strip: markedFor("strip"),
};

/** Markdown (CommonMark + GFM) → sanitized, style-free HTML. */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  const rawHtml = options.rawHtml ?? "escape";
  const html = RENDERERS[rawHtml].parse(markdown, { async: false }) as string;
  return sanitizeHtml(html, sanitizerOptions(options.allowImages ?? true));
}

/**
 * Render a parsed artifact's body. Refuses a document whose `format:` this
 * version cannot render rather than guessing — the same rule the parser applies.
 */
export function renderArtifactBody(doc: ArtifactDocument, options: RenderOptions = {}): string {
  const format = bodyFormatOf(doc.frontMatter);
  if (format !== "markdown") {
    throw new ArtifactFormatError("UNSUPPORTED_FORMAT", `cannot render body format ${JSON.stringify(format)}`);
  }
  return renderMarkdown(doc.body, options);
}
