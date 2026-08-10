/**
 * Copy-command path for continuing a run's coding-agent session locally.
 *
 * Execution is BYOA - the session lives on the owner's machine, so the server
 * can only hand back a ready-to-paste terminal command. Pure + unit-testable,
 * mirroring `editPrompt.ts`. ACP-backed Codex runs report their Codex thread id,
 * so the command must follow the recorded loop agent instead of assuming every
 * captured session belongs to Claude.
 */

/** Single-quote a path for POSIX shells (embedded `'` becomes `'\''`). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Build the terminal command that resumes a run's coding-agent session:
 *  `cd '<dir>' && <agent resume command>` when the loop's on-disk dir is known
 *  (resume is cwd-scoped), or the bare resume command when it isn't - never a
 *  fabricated path (same degradation contract as `loopDir`). `agent` defaults
 *  to Claude for older callers/runs; Grok currently does not report resumable
 *  session ids, so it intentionally follows that legacy fallback. */
export function buildResumeCommand({
  sessionId,
  dir,
  agent = 'claude-code',
}: {
  sessionId: string
  dir?: string | null
  agent?: 'claude-code' | 'codex'
}): string {
  const resume = agent === 'codex' ? `codex exec resume ${sessionId}` : `claude --resume ${sessionId}`
  return dir ? `cd ${shellQuote(dir)} && ${resume}` : resume
}
