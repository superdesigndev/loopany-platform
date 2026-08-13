import { agentProfile } from "./model";
import { resumeCommand } from "./taskLayouts";
import { CopyAction } from "./DisplayPrimitives";

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

/** A compact, human-readable reference to a coding-agent session. */
export function AgentSessionRef({ sessionId, assignee, workdir, compact = false }: { sessionId?: string | null; assignee?: string | null; workdir?: string | null; compact?: boolean }) {
  if (!sessionId) return <span>not recorded</span>;
  const profile = agentProfile(assignee) ?? "agent";
  if (compact) return <span title={sessionId}>session {shortId(sessionId)}</span>;
  const command = resumeCommand(profile, sessionId, workdir);
  return <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
    <span title={sessionId}><strong>{profile}</strong> · {shortId(sessionId)}</span>
    <CopyAction value={sessionId}>Copy ID</CopyAction>
    <CopyAction value={command}>Copy resume</CopyAction>
  </span>;
}
