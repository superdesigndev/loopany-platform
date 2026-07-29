# `@loopany/artifact-format`

The **artifact file format v1**: YAML front matter + Markdown as the canonical
form of a stored artifact, with sanitized HTML as a *projection* of it.

Pure library. No I/O, no server internals, no globals — parse, serialize,
render, that is all.

## The format contract

An artifact file is **one YAML front-matter block followed by a Markdown body**.
Canonical extension `.md`; the parser itself is extension-agnostic.

```md
---
type: defect
status: fixing
title: Sync floods on a worktree drop
source: github
externalId: superdesigndev/loopany-platform/issues/1291
sourceUrl: https://github.com/superdesigndev/loopany-platform/issues/1291
createdAt: 2026-07-01T00:00:00Z
updatedAt: 2026-07-29T09:15:00Z
attachments:
  - manifest-trace.json
severity: p1
---

# Sync floods on a worktree drop

A run dropped a 1.3 GB worktree inside the loop folder and the watcher tried to
sync all 125k files.

| step      | owner | done |
|:----------|:------|:----:|
| reproduce | ana   | yes  |
| fix       | bo    | no   |
```

### Front matter is the machine head

Only fields **the system acts on** live in the front matter — type, state,
provenance, timestamps, plus whatever the per-type registry adds. Anything that
exists only for a human reader belongs in the body.

The core schema this library validates:

| field | type | notes |
|:--|:--|:--|
| `type` | string | **required**, non-empty — the registry type key |
| `status` | string | state in the type's machine; the vocabulary is the registry's business, not this library's |
| `title` | string | display title (machine-acted: listing, search) |
| `format` | `markdown` | absent means `markdown`; any other value is an error |
| `source` | string | external system, e.g. `github` |
| `externalId` | string | identity within `source`; **requires `source`** (a mirror is keyed by source + externalId) |
| `sourceUrl` | string | canonical URL of the external fact |
| `createdAt` / `updatedAt` | string | RFC 3339 date-time **with an explicit offset** |
| `attachments` | string[] | legal data, **no rendering semantics** — nothing here resolves, fetches, or embeds them |

**Every other key is preserved verbatim** through parse → serialize. That is the
extension point: the type registry adds per-type fields without this library
changing.

### The body is always Markdown

CommonMark + GFM tables. There is no `format: html` in v1 — an explicit unknown
`format:` is a loud validation error, never a silent fallback. The body is
stored and round-tripped **byte-exactly**, including the customary blank line
after the closing `---` (that newline is part of the body).

### Rendering is a projection

Markdown → sanitized, **style-free semantic HTML**. The product supplies the
CSS; this library emits no `style`, no `class` (except a code block's
`language-*` hint), and no presentational attributes. GFM column alignment is
carried as `data-align="left|center|right"` so CSS can select on it without the
library shipping presentation.

## Usage

```ts
import {
  parseArtifact,
  serializeArtifact,
  updateArtifactFrontMatter,
  renderArtifactBody,
  safeParseArtifact,
  ArtifactFormatError,
} from "@loopany/artifact-format";

const doc = parseArtifact(text);          // throws ArtifactFormatError on anything malformed
doc.frontMatter.status;                   // "fixing"
doc.body;                                 // the Markdown, byte-exact

// A state transition: head edited, body untouched by construction.
const next = updateArtifactFrontMatter(doc, { status: "verifying" });
const bytes = serializeArtifact(next);

const html = renderArtifactBody(next);    // sanitized, style-free

// Batch ingress that must not abort on one bad file:
const result = safeParseArtifact(text);
if (!result.ok) console.warn(result.error.code, result.error.issues);
```

## Guarantees

**Round trip.** `parseArtifact(serializeArtifact(doc))` deep-equals `doc`, and
`serializeArtifact` is a *pure function of the data*: two documents with equal
front matter and identical bodies produce identical bytes regardless of key
insertion order. Canonical order is core fields in their declared order, then
every other key lexicographically, at every depth. Lists keep their order (a
list is ordered data). A `undefined` value means "absent", and is dropped.

**Loud failure.** There is no lenient path — a file that opens a front-matter
block and then malforms it is an error, never a document that silently becomes
"all body". Every rejection is an `ArtifactFormatError` with a `code`:

`MISSING_FRONT_MATTER`, `UNTERMINATED_FRONT_MATTER`, `INVALID_YAML`,
`FRONT_MATTER_NOT_MAPPING`, `DOCUMENT_TOO_LARGE`, `FRONT_MATTER_TOO_LARGE`,
`FRONT_MATTER_TOO_DEEP`, `FRONT_MATTER_TOO_MANY_NODES`, `UNSUPPORTED_FORMAT`,
`SCHEMA_VIOLATION` (with field-level `issues`).

**Hostile input.** YAML is parsed strictly on the **1.2 core schema** — no
`!!timestamp` coercion (`2026-07-29` stays a string), no YAML 1.1 booleans (`no`
stays `"no"`), duplicate keys rejected, unresolved tags rejected, alias
expansion capped (billion-laughs). Size, depth and node-count ceilings are
enforced and configurable via `ParseOptions.limits`; each one fails loudly
rather than clipping. Only the **first** closing `---` closes the block, so a
`---` inside the body is inert, not a front-matter injection point.

**Sanitization.** Two independent defenses, so a behavior change in either
dependency cannot silently open a hole:

1. Raw HTML never reaches the HTML layer — the Markdown renderer escapes it
   (default) or drops it (`{ rawHtml: "strip" }`), so `<script>` is text.
2. Whatever the Markdown renderer emits is filtered through a strict allowlist
   (tags, attributes, URL schemes) by `sanitize-html`.

No scripts, iframes, forms, event-handler attributes, inline styles, or
`javascript:` / `data:` / protocol-relative URLs survive. Images are limited to
`http(s)` and can be disabled with `{ allowImages: false }`.

## Relationship to the v2 loop-product front matter

`packages/server/src/server/frontmatter.ts` is a *soft* convention over synced
loop products: zero-dependency, forgiving, never throws, indexes only
`{type, title, date}`. This package is the opposite by design — it is the
**canonical format of a stored artifact**, so it is strict and it throws. They
are not interchangeable and neither replaces the other today.

## Development

```sh
pnpm --filter @loopany/artifact-format test        # vitest
pnpm --filter @loopany/artifact-format typecheck
pnpm --filter @loopany/artifact-format build       # tsc -> dist
```
