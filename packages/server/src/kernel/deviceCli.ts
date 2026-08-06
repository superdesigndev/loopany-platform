/**
 * Device-credential entrance for the argv transport.
 *
 * `/api/machine/cli` is an alternate transport over the same kernel operations,
 * not a second authority model. The caller has already been authenticated as an
 * enrolled machine; this module only translates the compact argv envelope into
 * the object handlers that also back the REST routes.
 */
import type { Machine } from "../db/schema.js";
import { teamIdForUser } from "../db/store.js";
import type { HttpResult } from "../gateway/http.js";
import { resolveObjectRef } from "./objectRefs.js";
import {
  closeTask,
  createFromArtifact,
  inbox,
  leaveDirective,
  listTasks,
  patchTask,
  replaceFromArtifact,
  showObject,
  verdict,
  type ApiResult,
} from "./objectApi.js";
import { attachMirror, detachMirror, listMirrors, mirrorKinds, patchMirror, showMirror } from "./mirrorApi.js";
import { REFUSAL_STATUS, refusal } from "./refusals.js";
import type { ApiContext } from "./apiAuth.js";

type Flags = Record<string, string | true>;

function parse(args: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const equal = arg.indexOf("=");
    if (equal > 2) { flags[arg.slice(2, equal)] = arg.slice(equal + 1); continue; }
    const key = arg.slice(2);
    const next = args[i + 1];
    // Artifact bytes normally begin with `---`; unlike an ordinary flag value,
    // that must not be mistaken for another option.
    if (next !== undefined && (key === "file-content" || !next.startsWith("--"))) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { flags, positional };
}

function text(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function result(r: ApiResult<Record<string, unknown>>): HttpResult {
  if (r.ok) return { status: r.status ?? 200, body: { text: text(r.value), exitCode: 0 } };
  const status = REFUSAL_STATUS[r.error.code];
  return { status, body: { text: text(r.error as unknown as Record<string, unknown>), exitCode: status === 404 ? 3 : status === 401 || status === 429 ? 1 : 2 } };
}

function bad(message: string): HttpResult {
  return result({ ok: false, error: refusal("INVALID_BODY", message, [], "run the command with --help and correct the named argument") });
}

function artifact(flags: Flags): string | undefined {
  return typeof flags["file-content"] === "string" ? flags["file-content"] : undefined;
}

function nullable(value: string | true | undefined): string | null | undefined {
  return value === "null" ? null : typeof value === "string" ? value : undefined;
}

/** Return undefined when argv does not name a kernel object command. */
export async function dispatchDeviceKernelCli(machine: Machine, argv: string[]): Promise<HttpResult | undefined> {
  const noun = argv[0];
  if (!noun || !["task", "doc", "mirror", "inbox", "answer"].includes(noun)) return undefined;
  const context: ApiContext = {
    teamId: machine.teamId ?? teamIdForUser(machine.userId),
    actor: { entrance: "human", actorId: machine.userId },
    mode: "human",
    machine,
  };
  const verb = noun === "inbox" || noun === "answer" ? noun : argv[1];
  const rest = noun === "inbox" || noun === "answer" ? argv.slice(1) : argv.slice(2);
  const { flags, positional } = parse(rest);
  const id = positional[0];

  if (noun === "inbox") return result(await inbox(context));
  if (noun === "answer") {
    if (!id || !positional[1]) return bad("answer requires a task id and non-empty answer text");
    return result(await verdict(await resolveObjectRef(id, context.teamId), positional[1], context));
  }

  if (noun === "task") {
    if (verb === "list") {
      const query = new URLSearchParams({ status: flags.closed === true ? "closed" : "open" });
      if (flags.due === true) query.set("due", "true");
      for (const key of ["watcher", "creator", "since", "limit", "cursor"]) if (typeof flags[key] === "string") query.set(key, flags[key]);
      return result(await listTasks(context, query));
    }
    if (verb === "show") return id ? result(await showObject("task", await resolveObjectRef(id, context.teamId), context, flags.full === true ? 200 : 20)) : bad("task show requires a task id");
    if (verb === "create") return artifact(flags) !== undefined ? result(await createFromArtifact("task", artifact(flags)!, context)) : bad("task create requires --file-content");
    if (verb === "update") {
      if (!id) return bad("task update requires a task id");
      const taskId = await resolveObjectRef(id, context.teamId);
      if (artifact(flags) !== undefined) return result(await replaceFromArtifact("task", taskId, artifact(flags)!, context));
      let payloadMerge: unknown;
      if (typeof flags["payload-merge"] === "string") {
        try { payloadMerge = JSON.parse(flags["payload-merge"]); } catch { return bad("--payload-merge must be a JSON object"); }
      }
      const patch: Record<string, unknown> = {};
      const followUp = nullable(flags["follow-up"]); if (followUp !== undefined) patch.followUp = followUp;
      const parent = nullable(flags.parent); if (parent !== undefined) patch.parent = parent;
      const needsHuman = nullable(flags["needs-human"]); if (needsHuman !== undefined) patch.needsHuman = needsHuman;
      if (payloadMerge !== undefined) patch.payloadMerge = payloadMerge;
      return result(await patchTask(taskId, patch, context));
    }
    if (verb === "close") return id ? result(await closeTask(await resolveObjectRef(id, context.teamId), flags.note, context)) : bad("task close requires a task id");
    if (verb === "tell") return id && positional[1] ? result(await leaveDirective(await resolveObjectRef(id, context.teamId), positional[1], context)) : bad("task tell requires a task id and directive text");
  }

  if (noun === "doc") {
    if (verb === "show") return id ? result(await showObject("doc", await resolveObjectRef(id, context.teamId), context)) : bad("doc show requires a doc id");
    if (verb === "create") return artifact(flags) !== undefined ? result(await createFromArtifact("doc", artifact(flags)!, context)) : bad("doc create requires --file-content");
    if (verb === "update") return id && artifact(flags) !== undefined ? result(await replaceFromArtifact("doc", await resolveObjectRef(id, context.teamId), artifact(flags)!, context)) : bad("doc update requires a doc id and --file-content");
  }

  if (noun === "mirror") {
    if (verb === "list") { const query = new URLSearchParams(); for (const key of ["attached-to", "kind", "coords-like", "limit"]) if (typeof flags[key] === "string") query.set(key, flags[key]); return result(await listMirrors(context, query)); }
    if (verb === "kinds") return result(await mirrorKinds(context));
    if (verb === "show") return id ? result(await showMirror(id, context)) : bad("mirror show requires a mirror id");
    if (verb === "attach") return id ? result(await attachMirror({ objectId: id, kind: flags.kind, coords: flags.coords, note: flags.note }, context)) : bad("mirror attach requires an object id");
    if (verb === "detach") return id ? result(await detachMirror(id, flags.from, context)) : bad("mirror detach requires a mirror id");
    if (verb === "update") return id ? result(await patchMirror(id, { note: nullable(flags.note) }, context)) : bad("mirror update requires a mirror id");
  }

  return bad(`unknown kernel command ${JSON.stringify(argv.join(" "))}`);
}
