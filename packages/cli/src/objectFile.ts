/**
 * KernelObject <-> on-disk `.md` mapping, routed through the shared
 * @loopany/artifact-format codec (owner directive — the CLI no longer ships a
 * hand-rolled codec). The front matter carries every scalar field in a fixed
 * key order (so a re-serialize is byte-stable); the markdown `body` (task/doc
 * only) lives below the fence verbatim.
 *
 * The kernel owns the object shapes; this module only decides the FILE layout,
 * so the field lists here mirror types.ts exactly and a drift is a parse/shape
 * error rather than silent data loss. The artifact-format codec is a PURE
 * STRUCTURAL library with zero domain knowledge (it enforces only "the head is
 * a YAML mapping"), so this seam owns the per-archetype key sets and the value
 * typing — the codec preserves whatever we hand it verbatim.
 */
import {
  type KernelObject,
  type TaskStatus,
  TASK_STATUSES,
} from "@loopany/kernel";
import {
  ArtifactFormatError,
  type ArtifactDocument,
  type ArtifactFrontMatter,
  parseArtifact,
  serializeArtifact,
} from "@loopany/artifact-format";

/** A codec-layer error the driver wraps into a DriverError. Named to keep the
 *  old `CodecError` call sites (objectFile + driver) working while the on-disk
 *  format moves under the workspace codec. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

/** Fixed head key order per archetype (deterministic serialization). `body` is
 *  intentionally absent — it is the below-the-fence content, not front matter. */
const TASK_KEYS = [
  "archetype",
  "id",
  "title",
  "status",
  "assignee",
  "priority",
  "type",
  "parent",
  "tracks",
  "refs",
  "followUpAt",
  "owner",
  "workdir",
  "version",
  "createdAt",
  "updatedAt",
] as const;

// doc.body is a real object field, but on disk it lives BELOW the fence like a
// task body (docs are read as prose), so it is not a head key.
const DOC_KEYS = ["archetype", "id", "key", "title", "version", "createdAt", "updatedAt"] as const;

const MIRROR_KEYS = ["archetype", "id", "kind", "coords", "version", "createdAt", "updatedAt"] as const;

function keyOrderFor(archetype: string): readonly string[] {
  if (archetype === "task") return TASK_KEYS;
  if (archetype === "doc") return DOC_KEYS;
  return MIRROR_KEYS;
}

export function objectToDocument(obj: KernelObject): ArtifactDocument {
  const frontMatter: Record<string, unknown> = {};
  if (obj.archetype === "task") {
    for (const k of TASK_KEYS) frontMatter[k] = normalizeOut(obj[k]);
    return { frontMatter, body: obj.body };
  }
  if (obj.archetype === "doc") {
    for (const k of DOC_KEYS) frontMatter[k] = normalizeOut(obj[k as keyof typeof obj]);
    return { frontMatter, body: obj.body };
  }
  for (const k of MIRROR_KEYS) frontMatter[k] = normalizeOut(obj[k as keyof typeof obj]);
  return { frontMatter, body: "" };
}

/** The artifact codec DROPS `undefined` keys (a spread-`undefined` means "no
 *  such key") but preserves `null`. Kernel optionals are already `null`, and
 *  `refs` is materialized as an array — so normalization is a pass-through that
 *  only guards against a stray `undefined` sneaking a required key off disk. */
function normalizeOut(v: unknown): unknown {
  return v === undefined ? null : v;
}

// ---- typed field readers over the parsed front matter ----

function reqString(fm: ArtifactFrontMatter, key: string): string {
  const v = fm[key];
  if (typeof v !== "string") throw new CodecError(`object field "${key}" must be a string`);
  return v;
}

function optString(fm: ArtifactFrontMatter, key: string): string | null {
  const v = fm[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new CodecError(`object field "${key}" must be a string or null`);
  return v;
}

function reqNumber(fm: ArtifactFrontMatter, key: string): number {
  const v = fm[key];
  if (typeof v !== "number") throw new CodecError(`object field "${key}" must be a number`);
  return v;
}

function reqStringArray(fm: ArtifactFrontMatter, key: string): string[] {
  const v = fm[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new CodecError(`object field "${key}" must be a string array`);
  }
  return [...(v as string[])];
}

/** Validate a status field against the kernel's closed status set. A workspace
 *  file hand-edited to `status: banana` must be refused as corrupt, never cast
 *  blindly to TaskStatus and loaded (C6). */
function reqStatus(fm: ArtifactFrontMatter, key: string): TaskStatus {
  const v = reqString(fm, key);
  if (!(TASK_STATUSES as readonly string[]).includes(v)) {
    throw new CodecError(`object field "${key}" is not a valid status: "${v}" (valid: ${TASK_STATUSES.join(" | ")})`);
  }
  return v as TaskStatus;
}

/** Refuse a front-matter key outside the archetype's closed set. The codec
 *  preserves every key verbatim on parse but serializeObject writes ONLY the
 *  archetype's key list — so an unknown key (`customField: precious`) would load
 *  fine and then be SILENTLY DROPPED on the next update-rewrite. This module's
 *  contract is "a drift is a parse/shape error rather than silent data loss"
 *  (matching the C6/C7 strict-load posture), so extras are refused at load. */
function rejectUnknownKeys(fm: ArtifactFrontMatter, known: readonly string[]): void {
  const allowed = new Set(known);
  const extras = Object.keys(fm).filter((k) => !allowed.has(k));
  if (extras.length > 0) {
    throw new CodecError(
      `unknown front-matter key(s): ${extras.join(", ")} (allowed: ${known.join(", ")})`,
    );
  }
}

export function documentToObject(doc: ArtifactDocument): KernelObject {
  const fm = doc.frontMatter;
  const archetype = reqString(fm, "archetype");
  if (archetype === "task" || archetype === "doc" || archetype === "mirror") {
    rejectUnknownKeys(fm, keyOrderFor(archetype));
  }
  if (archetype === "task") {
    return {
      archetype: "task",
      id: reqString(fm, "id"),
      title: reqString(fm, "title"),
      status: reqStatus(fm, "status"),
      assignee: optString(fm, "assignee"),
      priority: optString(fm, "priority"),
      type: optString(fm, "type"),
      parent: optString(fm, "parent"),
      tracks: optString(fm, "tracks"),
      refs: reqStringArray(fm, "refs"),
      followUpAt: optString(fm, "followUpAt"),
      owner: optString(fm, "owner"),
      workdir: optString(fm, "workdir"),
      body: doc.body,
      version: reqNumber(fm, "version"),
      createdAt: reqString(fm, "createdAt"),
      updatedAt: reqString(fm, "updatedAt"),
    };
  }
  if (archetype === "doc") {
    return {
      archetype: "doc",
      id: reqString(fm, "id"),
      key: reqString(fm, "key"),
      title: optString(fm, "title"),
      body: doc.body,
      version: reqNumber(fm, "version"),
      createdAt: reqString(fm, "createdAt"),
      updatedAt: reqString(fm, "updatedAt"),
    };
  }
  if (archetype === "mirror") {
    return {
      archetype: "mirror",
      id: reqString(fm, "id"),
      kind: reqString(fm, "kind"),
      coords: reqString(fm, "coords"),
      version: reqNumber(fm, "version"),
      createdAt: reqString(fm, "createdAt"),
      updatedAt: reqString(fm, "updatedAt"),
    };
  }
  throw new CodecError(`unknown object archetype "${archetype}"`);
}

export function serializeObject(obj: KernelObject): string {
  const doc = objectToDocument(obj);
  try {
    return serializeArtifact(doc, { keyOrder: [...keyOrderFor(obj.archetype)] });
  } catch (e) {
    // The codec's write path enforces the same hostile-input ceilings as its
    // read path (e.g. a body over the byte ceiling). parseObject already wraps
    // ArtifactFormatError; the serialize side must too, or an oversize --body-file
    // escapes as a raw ArtifactFormatError past the driver's error boundary.
    if (e instanceof ArtifactFormatError) throw new CodecError(e.message);
    throw e;
  }
}

export function parseObject(text: string): KernelObject {
  let doc: ArtifactDocument;
  try {
    doc = parseArtifact(text);
  } catch (e) {
    if (e instanceof ArtifactFormatError) throw new CodecError(e.message);
    throw e;
  }
  return documentToObject(doc);
}
