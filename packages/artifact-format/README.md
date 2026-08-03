# `@loopany/artifact-format`

The **artifact file format codec**: YAML front matter + an opaque body, parsed
and serialized as deterministic inverses.

A **pure structural codec**. No I/O, no server internals, no globals — and no
domain knowledge. It knows that the head is a YAML mapping and that the body is
bytes. It does not know what a task is, which keys a document kind may carry, or
what any of them mean. That lives in the server-side seam.

Its whole dependency budget is `yaml`.

## The format contract

An artifact file is **one YAML front-matter block followed by a body**.
Canonical extension `.md`; the parser itself is extension-agnostic.

```md
---
attachments:
  - manifest-trace.json
createdAt: 2026-07-01T00:00:00Z
externalId: superdesigndev/loopany-platform/issues/1291
format: markdown
kind: defect
severity: p1
source: github
state: fixing
---

# Sync floods on a worktree drop

A run dropped a 1.3 GB worktree inside the loop folder and the watcher tried to
sync all 125k files.
```

Every key above except `format` is **opaque data** to this library. The example
shows the keys a caller might use; the codec neither requires nor recognizes any
of them.

### Front matter is a plain mapping

The codec enforces exactly two rules:

1. the front matter parses to a **YAML mapping**;
2. if it declares a `format`, that format is one the codec knows.

There is no required key, no field vocabulary, and no cross-field rule. **Every
other key is preserved verbatim** through parse → serialize. Pass-through is the
*correct* behavior here, not a fallback: an unknown key is not a key the codec
failed to understand, it is a key that is none of the codec's business.
Rejection happens at the server seam, against the object kind's declared key set.

| field | type | notes |
|:--|:--|:--|
| `format` | `markdown` \| `html` | the ONLY key the codec recognizes; absent means `markdown` |

`format` is an **enum and nothing more**. The codec attaches no rendering
semantics to either value and treats both bodies identically; which object kinds
may use `html` is server-side policy.

### The body is opaque

Whatever bytes follow the closing delimiter come back identically — no trimming,
no padding, no line-ending rewriting. The customary blank line after `---` is
**part of the body** and is preserved. The codec never parses, renders, or
normalizes it.

Only the **first** closing `---` closes the head, which is what makes a `---`
inside the body inert rather than a front-matter injection point.

## Usage

```ts
import {
  parseArtifact,
  serializeArtifact,
  updateArtifactFrontMatter,
  safeParseArtifact,
  checkTimestamp,
  ArtifactFormatError,
} from "@loopany/artifact-format";

const doc = parseArtifact(text);          // throws ArtifactFormatError on anything malformed
doc.frontMatter.state;                    // whatever the caller put there
doc.body;                                 // bytes, exact

// A state transition: head edited, body untouched by construction.
const next = updateArtifactFrontMatter(doc, { state: "verifying" });

// Default order is pure lexicographic; ask for a different head order if you want one.
serializeArtifact(next);
serializeArtifact(next, { keyOrder: ["kind", "state"] });

// Batch ingress that must not abort on one bad file:
const result = safeParseArtifact(text);
if (!result.ok) console.warn(result.error.code, result.error.issues);

// The timestamp helper the codec applies to nothing:
const issues = ["createdAt", "updatedAt"]
  .map((key) => checkTimestamp(doc.frontMatter[key], key))
  .filter((issue) => issue !== null);
```

## Guarantees

**Round trip.** `parseArtifact(serializeArtifact(doc))` deep-equals `doc`, and
`serializeArtifact` is a *pure function of the data*: two documents with equal
front matter and identical bodies produce identical bytes regardless of key
insertion order **and regardless of the host's locale** (ordering compares code
units, never `localeCompare`). Lists keep their order — a list is ordered data.
An `undefined` value means "absent" and is dropped, not emitted as `null`.

**Key order is the caller's.** No key is privileged. The default is pure
lexicographic at every depth; `serializeArtifact(doc, { keyOrder })` puts the
named keys first in the given order and sorts the rest. `keyOrder` applies to
the top-level mapping only — a caller's intent for the head must not reach down
and reorder a nested value that merely shares a key name. A listed key the data
does not have is skipped rather than invented; a key listed twice keeps its
first position; `[]` behaves like omitting the option.

**Loud failure.** There is no lenient path — a file that opens a front-matter
block and then malforms it is an error, never a document that silently becomes
"all body". Every rejection is an `ArtifactFormatError` with a `code`:

`MISSING_FRONT_MATTER`, `UNTERMINATED_FRONT_MATTER`, `INVALID_YAML`,
`FRONT_MATTER_NOT_MAPPING`, `DOCUMENT_TOO_LARGE`, `FRONT_MATTER_TOO_LARGE`,
`FRONT_MATTER_TOO_DEEP`, `FRONT_MATTER_TOO_MANY_NODES`, `UNSUPPORTED_FORMAT`,
`SCHEMA_VIOLATION` (with field-level `issues`).

Issues **accumulate**: one malformed document reports every problem at once,
each with a path a caller can act on (`nested.third`, `list[1]`), instead of
marching them through one round trip at a time.

**Hostile input.** YAML is parsed strictly on the **1.2 core schema** — no
`!!timestamp` coercion (`2026-07-29` stays a string), no YAML 1.1 booleans (`no`
stays `"no"`), duplicate keys rejected, unresolved tags rejected, alias
expansion capped (billion-laughs). Size, depth and node-count ceilings are
enforced and configurable via `limits`; each fails loudly rather than clipping,
and the depth walk is iterative so a pathological input cannot exhaust the host
stack. Host objects (`Date`, `Map`, `Set`, class instances, functions, symbols,
bigints) are rejected rather than silently flattened to `{}`.

**No rendering.** The body is bytes. There is no markdown pipeline, no
sanitizer, and no HTML in this package — a consumer that wants to display a body
renders it itself, under its own policy.

## Development

```sh
pnpm --filter @loopany/artifact-format test        # vitest
pnpm --filter @loopany/artifact-format typecheck
pnpm --filter @loopany/artifact-format build       # tsc -> dist
```

`test/target.ts` states the intended public surface and `src/codec.surface.test.ts`
pins it, so an export cannot appear or vanish unnoticed.
