export type KernelAuthority = "device" | "human-session" | "agent-run";

export interface AuthorityRequest {
  tick?: boolean;
  read?: boolean;
  timeline?: unknown;
  command?: unknown;
}

export interface AgentRunAuthorityContext {
  runId: string;
  state: "active" | "terminal-grace";
}

export type AuthorityRefusal = { status: 403 | 409; code: string; message: string };

function opOf(command: unknown): string {
  return command !== null && typeof command === "object" && !Array.isArray(command)
    ? String((command as { op?: unknown }).op ?? "")
    : "";
}

/** The one server-hosted authority policy. Provenance is audit data and never
 * grants permission. Every HTTP entrance calls this before the pure Kernel. */
export function authorizeKernelRequest(
  authority: KernelAuthority,
  req: AuthorityRequest,
  run?: AgentRunAuthorityContext,
): AuthorityRefusal | null {
  if (authority === "device") return null;
  if (authority === "human-session") {
    if (req.read || req.timeline !== undefined) return null;
    if (req.tick) return { status: 403, code: "FORBIDDEN", message: "a human session cannot host-tick" };
    const op = opOf(req.command);
    const allowed = new Set(["create", "update", "note", "doc-put", "doc-append", "mirror-add", "run", "delete"]);
    return allowed.has(op)
      ? null
      : { status: 403, code: "FORBIDDEN", message: `a human session cannot issue "${op}"` };
  }

  if (!run) return { status: 403, code: "FORBIDDEN", message: "missing agent-run authority context" };
  if (run.state === "terminal-grace") {
    return { status: 409, code: "CONFLICT", message: "this run was reclaimed; its credential can no longer read or write" };
  }
  if (req.tick) return { status: 403, code: "FORBIDDEN", message: "a run credential cannot host-tick (owner/host surface)" };
  if (req.read || req.timeline !== undefined) return null;
  const op = opOf(req.command);
  const allowed = new Set(["create", "update", "note", "doc-put", "doc-append", "mirror-add", "run-finish"]);
  if (!allowed.has(op)) {
    return { status: 403, code: "FORBIDDEN", message: `a run credential cannot issue "${op}" (allowed: ${[...allowed].join(", ")})` };
  }
  if (op === "run-finish") {
    const runId = String((req.command as { runId?: unknown }).runId ?? "");
    if (runId !== run.runId) return { status: 403, code: "FORBIDDEN", message: "a run may finish only ITS OWN run" };
  }
  return null;
}
