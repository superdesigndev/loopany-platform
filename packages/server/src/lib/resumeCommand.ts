/**
 * Copy-command path for continuing a run's coding-agent session locally.
 *
 * Execution is BYOA - the session lives on the owner's machine, so the server
 * can only hand back a ready-to-paste terminal command. Pure + unit-testable,
 * mirroring `editPrompt.ts`. The binary is literally `claude` because execution
 * is always Claude today (`loops.agent` is recording-only) - branch on the
 * loop's agent here if codex execution ever ships.
 */

/** Single-quote a path for POSIX shells (embedded `'` becomes `'\''`). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Build the terminal command that resumes a run's coding-agent session:
 *  `cd '<dir>' && claude --resume <id>` when the loop's on-disk dir is known
 *  (resume is cwd-scoped), or the bare resume command when it isn't - never a
 *  fabricated path (same degradation contract as `loopDir`). */
export function buildResumeCommand({
  sessionId,
  dir,
}: {
  sessionId: string
  dir?: string | null
}): string {
  const resume = `claude --resume ${sessionId}`
  return dir ? `cd ${shellQuote(dir)} && ${resume}` : resume
}
