/**
 * Copy-prompt path for the loop-detail Edit composer.
 *
 * The dispatch path (`requestEdit`) runs ONE agent pass on the owner's machine -
 * spends credits, no conversation. This is the non-dispatch alternative: a
 * self-contained prompt the owner pastes into their OWN local coding-agent
 * session (in the loop's directory) so they can iterate/converse and adjust the
 * loop themselves. Pure + agent-neutral so it's unit-testable and never inlines
 * user text unsafely into JSX.
 */

/** The loop's on-disk folder — the containing directory of its task file
 *  (e.g. `.../adscaile/<loop>/`). Returns null when the task file path is absent
 *  or has no parent, so callers degrade to a generic instruction rather than
 *  fabricating a path. Handles both POSIX and Windows separators. */
export function loopDir(taskFile?: string | null): string | null {
  if (!taskFile) return null
  const norm = taskFile.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = norm.lastIndexOf('/')
  return i > 0 ? norm.slice(0, i) : null
}

/** Build the ready-to-paste prompt for a fresh coding-agent session: it states
 *  that they're adjusting a named adScaile loop, what the owner wants (their typed
 *  instruction, or a clear placeholder asking them to describe it), and that the
 *  agent should drive the installed adscaile CLI/skill (`adscaile loops`,
 *  `adscaile edit <id> ...`) to apply and confirm the change. Concise, agent-neutral. */
export function buildEditPrompt({
  loopId,
  loopName,
  instruction,
}: {
  loopId: string
  loopName: string
  instruction?: string
}): string {
  const want = instruction?.trim() || 'Describe the change you want to make to this loop.'
  return [
    `I want to adjust my adScaile loop "${loopName}" (loop id: ${loopId}).`,
    '',
    'The change I want:',
    want,
    '',
    `Use the installed adscaile CLI/skill to apply it: run \`adscaile loops\` to find the loop, then \`adscaile edit ${loopId} ...\` to make the change, and confirm the loop now reflects it. Ask me first if anything is unclear.`,
  ].join('\n')
}
