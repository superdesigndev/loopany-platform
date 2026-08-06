/**
 * THE REFUSAL CATALOGUE — one structured envelope for every refusal the rewrite
 * surface can emit (API spec §3.1), plus a first-class template per code.
 *
 * Why the templates are constants rather than strings inlined at each call site:
 * the CLI is a teacher, not a gatekeeper (design §8), and the teaching is
 * authored HERE, server-side, so a refusal can never reach an agent as an empty
 * or generic envelope. `refusals.test.ts` renders every entry and asserts each
 * one carries a real sentence, a real hint, and a distinct HTTP status — the
 * guard-table the CLI scout asked for. A new code without a template fails to
 * typecheck, so the catalogue cannot drift behind the code list.
 *
 * Call sites may override `message`/`issues`/`hint` with something more specific
 * (the object's id, the offending value, the caller's own loop id). What they
 * may NOT do is emit a code with no teaching at all: `refusal()` falls back to
 * the template, never to an empty string.
 */
import { WATCHER_KEPT_HINT, type KernelIssue } from "./types.js";

export interface ApiRefusal {
  code: RefusalCode;
  message: string;
  issues: KernelIssue[];
  hint: string;
}

export const REFUSAL_CODES = [
  "UNKNOWN_KEY", "BAD_DATE", "UNSUPPORTED_FORMAT", "MISSING_FRONT_MATTER",
  "UNTERMINATED_FRONT_MATTER", "INVALID_YAML", "FRONT_MATTER_NOT_MAPPING",
  "SCHEMA_VIOLATION", "INVALID_BODY", "UNKNOWN_FILTER", "WATCHER_REQUIRED",
  "WATCHER_IMMUTABLE", "PARENT_CYCLE",
  "UNAUTHORIZED", "NOT_HUMAN", "NO_RUN_CONTEXT", "RUN_CONTEXT_UNKNOWN",
  "NOT_FOUND", "OPEN_QUESTION",
  "NO_OPEN_QUESTION", "WRONG_KIND", "KEY_KIND_MISMATCH", "IMMUTABLE_KEY",
  "CLOSED", "PAUSED", "QUEUED_ALREADY", "LEASE_LOST",
  "TOO_LARGE", "RATE_LIMITED", "ID_COLLISION",
  "IMMUTABLE_COORDS", "MIRROR_STATELESS", "RESERVED_KEY", "CHARTER_ONLY",
  "VERSION_CONFLICT", "EXPECTED_VERSION_REQUIRED", "NOT_YOUR_CHARTER",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Spec §3.2's code table. The CLI derives its exit code from the status alone
 *  (§4: 2xx→0, 404→3, 401/429/5xx→1, every other 4xx→2), so no prose is parsed. */
export const REFUSAL_STATUS: Record<RefusalCode, number> = {
  UNKNOWN_KEY: 400, BAD_DATE: 400, UNSUPPORTED_FORMAT: 400,
  MISSING_FRONT_MATTER: 400, UNTERMINATED_FRONT_MATTER: 400, INVALID_YAML: 400,
  FRONT_MATTER_NOT_MAPPING: 400, SCHEMA_VIOLATION: 400,
  INVALID_BODY: 400, UNKNOWN_FILTER: 400, WATCHER_REQUIRED: 400,
  WATCHER_IMMUTABLE: 409, PARENT_CYCLE: 409,
  UNAUTHORIZED: 401,
  NOT_HUMAN: 403, NO_RUN_CONTEXT: 403, RUN_CONTEXT_UNKNOWN: 403,
  NOT_FOUND: 404, OPEN_QUESTION: 409, NO_OPEN_QUESTION: 409, WRONG_KIND: 409,
  KEY_KIND_MISMATCH: 409, IMMUTABLE_KEY: 409, CLOSED: 409, PAUSED: 409,
  QUEUED_ALREADY: 409, LEASE_LOST: 409, TOO_LARGE: 413,
  RATE_LIMITED: 429, ID_COLLISION: 409,
  IMMUTABLE_COORDS: 409, MIRROR_STATELESS: 400,
  RESERVED_KEY: 409,
  CHARTER_ONLY: 409, VERSION_CONFLICT: 409, EXPECTED_VERSION_REQUIRED: 428,
  NOT_YOUR_CHARTER: 403,
};

interface RefusalTemplate {
  /** One sentence, present tense, stating the refusal. `%s` is the subject. */
  message: string;
  /** The legal next move(s). Never empty — a refusal with no way forward is a wall. */
  hint: string;
}

/**
 * The catalogue. Every string here is the FALLBACK an endpoint gets for free;
 * endpoints that know the offending value pass a richer message and `issues[]`.
 * `%s` interpolates the subject (an object id, a key, a field name).
 */
export const REFUSAL_TEMPLATES: Record<RefusalCode, RefusalTemplate> = {
  UNKNOWN_KEY: {
    message: `%s is not a key this kind accepts`,
    hint: "front matter is a closed set per kind; custom data goes under payload:",
  },
  BAD_DATE: {
    message: `%s is not a date this server accepts`,
    hint: "two forms only: RFC 3339 with an offset (2026-08-11T09:00:00Z) or a relative +3d / +12h computed on the server clock",
  },
  UNSUPPORTED_FORMAT: {
    message: `%s names a body format this kernel does not serve`,
    hint: "markdown is the default and html is doc-only; a task body is always Markdown",
  },
  MISSING_FRONT_MATTER: {
    message: `%s does not open with a front-matter fence`,
    hint: "an artifact file opens with ---, closes with ---, and carries a flat YAML mapping between them",
  },
  UNTERMINATED_FRONT_MATTER: {
    message: `%s opens a front-matter fence it never closes`,
    hint: "close the head with a --- line of its own before the body",
  },
  INVALID_YAML: {
    message: `%s does not parse as YAML`,
    hint: "fix the head so it is a flat YAML mapping, then upload the file again",
  },
  FRONT_MATTER_NOT_MAPPING: {
    message: `%s has front matter that is not a mapping`,
    hint: "the head must be key: value pairs, not a scalar or a list",
  },
  SCHEMA_VIOLATION: {
    message: `%s carries a known key with the wrong type`,
    hint: "every offending field is listed in issues; fix them all and retry",
  },
  INVALID_BODY: {
    message: `%s could not be read as the request body this endpoint expects`,
    hint: "send a JSON object with exactly the documented fields",
  },
  UNKNOWN_FILTER: {
    message: `%s is not a filter this list endpoint evaluates`,
    hint: "list filters are kernel query predicates; a narrower question is the agent's judgment, not a filter",
  },
  WATCHER_REQUIRED: {
    message: `%s would leave no loop watching it, and a task always names the loop that acts next`,
    hint: "name the loop that acts next: watcher: <loop-id> in the front matter, or --watcher <loop-id> on the CLI. `loopany loops` prints the ids you can name — a watcher is one of this machine's production loops, and the id is used verbatim. A paused loop is still a legal watcher: it acts the next time it runs. A task a run files defaults to that run's own loop, so only a hand-off needs the flag.",
  },
  WATCHER_IMMUTABLE: {
    message: `%s already names the loop that acts next, and a task keeps the watcher it was created with`,
    hint: WATCHER_KEPT_HINT,
  },
  PARENT_CYCLE: {
    message: `%s would sit inside its own subtree`,
    hint: "a task tree is a tree: pick a parent that is not this task and not underneath it, or clear the parent to make this task a root. Nothing was written.",
  },
  UNAUTHORIZED: {
    message: `%s carried no credential this server recognizes`,
    hint: "inside a run the run's own credential authenticates the call and the CLI attaches it; outside one it is the machine's device credential. If neither is recognized, re-register the machine with `loopany up`, then retry.",
  },
  NOT_HUMAN: {
    message: `%s requires owner authority`,
    hint: "a run lease cannot answer or withdraw a pending question, including one its own loop asked; it appears in the owner's inbox",
  },
  NO_RUN_CONTEXT: {
    message: `%s needs a run context and the request carried none`,
    hint: "lease-scoped calls run inside a run: the daemon sets LOOPANY_RUN_ID and the CLI attaches it. Outside a run, use an owner session or device credential.",
  },
  RUN_CONTEXT_UNKNOWN: {
    message: `%s is not a run this machine is currently holding`,
    hint: "the run may have finished or been reclaimed; stop here — the daemon claims a fresh one",
  },
  NOT_FOUND: {
    message: `%s was not found`,
    hint: "ids are server-issued and printed by every create and every list row — copy, do not compose",
  },
  OPEN_QUESTION: {
    message: `%s cannot be closed while a question is waiting for owner authority`,
    hint: "an owner-authority credential answers it in the inbox; after that the task closes normally",
  },
  NO_OPEN_QUESTION: {
    message: `%s has no open question to answer`,
    hint: "a verdict answers a pending question; refresh the inbox for the ones actually waiting",
  },
  WRONG_KIND: {
    message: `%s is not the kind this verb acts on`,
    hint: "the id names its own kind: task-, doc- and mirror- each have their own verbs, and a loop is the shipping product's (`loopany show <loop-id>`)",
  },
  KEY_KIND_MISMATCH: {
    message: `%s already names an object of a different kind in this team`,
    hint: "keys are unique per team across kinds; choose a different key",
  },
  IMMUTABLE_KEY: {
    message: `%s cannot be changed after creation`,
    hint: "a key is creation-time identity — restore the stored value or remove the line; nothing was written",
  },
  CLOSED: {
    message: `%s is closed`,
    hint: "closed is terminal and there is no reopen verb; create a new task for the follow-on work",
  },
  PAUSED: {
    message: `%s is paused`,
    hint: "time never un-pauses a loop — the owner resumes it with `loopany edit <loop-id> --json '{\"enabled\":true}'`",
  },
  QUEUED_ALREADY: {
    message: `%s already has a queued run`,
    hint: "one queued run per loop — the queued run will pick this up when it claims",
  },
  LEASE_LOST: {
    message: `%s is no longer yours to report`,
    hint: "stop work on it — the lease is the authority; the next claim will re-offer it",
  },
  TOO_LARGE: {
    message: `%s is larger than this endpoint accepts`,
    hint: "artifact uploads cap at 4 MB and JSON bodies at 512 KB",
  },
  RATE_LIMITED: {
    message: `%s was rate limited`,
    hint: "retry after the Retry-After interval; this is a transport condition, not a refusal of the work",
  },
  ID_COLLISION: {
    message: `%s already names a different object than the one this call derived it for`,
    hint: "this is a server-side identity fault, not a mistake in your command: the work did NOT happen and retrying re-derives the same id. Report it to the loop's owner.",
  },
  IMMUTABLE_COORDS: {
    message: `%s cannot be repointed — a mirror's coords are the external thing's identity`,
    hint: "a different PR is a different mirror: detach this one and attach a new one. Repointing the row would silently rewrite every timeline that already cites it.",
  },
  MIRROR_STATELESS: {
    message: `%s would give a mirror somewhere to record external state, and a mirror has nowhere by design`,
    hint: "a mirror tells you WHERE to look, never WHAT state it is in — record what you found on the task that owns the work, and let the next run go and look.",
  },
  RESERVED_KEY: {
    message: `%s is reserved for an attached loop charter`,
    hint: "choose another product key; charters are created and replaced through loop CRUD",
  },
  CHARTER_ONLY: {
    message: `%s is an attached loop charter, not a product doc`,
    hint: "read or replace it through `loopany show <loop-id> --charter` or `loopany edit <loop-id> --charter-file <path>`",
  },
  VERSION_CONFLICT: {
    message: `%s changed after the version this write read`,
    hint: "re-read the charter, reapply the intended edit to the newest body, and retry",
  },
  EXPECTED_VERSION_REQUIRED: {
    message: `%s requires an expected charter version`,
    hint: "send the ETag from the latest GET as If-Match; an unguarded whole-document replacement is refused",
  },
  NOT_YOUR_CHARTER: {
    message: `%s is outside this run lease's loop scope`,
    hint: "a run lease may read and write only objects owned by its own loop",
  },
};

/** Render a template, substituting the subject for `%s`. */
export function renderTemplate(code: RefusalCode, subject = "this request"): Omit<ApiRefusal, "code"> {
  const template = REFUSAL_TEMPLATES[code];
  return { message: template.message.replace("%s", subject), issues: [], hint: template.hint };
}

export function refusal(code: RefusalCode, message?: string, issues: KernelIssue[] = [], hint?: string): ApiRefusal {
  const base = renderTemplate(code);
  return { code, message: message ?? base.message, issues, hint: hint ?? base.hint };
}

/** The same envelope, with the subject filled in — the common call shape. */
export function refuseAbout(code: RefusalCode, subject: string, issues: KernelIssue[] = [], hint?: string): ApiRefusal {
  const base = renderTemplate(code, subject);
  return { code, message: base.message, issues, hint: hint ?? base.hint };
}

export function refusalResponse(value: ApiRefusal, init?: ResponseInit): Response {
  // The `?? 400` is a FLOOR, not a mapping. Several call sites widen a kernel
  // result code into this envelope with a cast (`refusal(result.code as never)`),
  // and a code with no row in the table would otherwise resolve to `undefined` —
  // which `Response.json` renders as **200**, so a refusal would reach the CLI as
  // a success and exit 0. Any unmapped code is a client error at worst.
  return Response.json(value, { ...init, status: init?.status ?? REFUSAL_STATUS[value.code] ?? 400 });
}
