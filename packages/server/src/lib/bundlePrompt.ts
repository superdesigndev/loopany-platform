/**
 * The bundle Copy-prompt builder (Loop Template Bundles).
 *
 * A bundle groups several template loops. Unlike a single template (which appends
 * one canned `description` to the bootstrap snippet), a bundle pastes a SELF-CONTAINED
 * candidate menu: the bootstrap instruction + machine config, a preamble that tells
 * the agent to inspect THIS project and recommend which members fit, a numbered
 * candidate list, and each member's FULL setup `description` inline — so no new serving
 * endpoint is needed. Pure + unit-tested (like `editPrompt.ts`) so the snippet never
 * drifts and can't inline user text unsafely into JSX.
 */
import type { BundleView } from '../types'

/**
 * Build the ready-to-paste bundle prompt. `instruction` (the one bootstrap sentence) and
 * `configLines` (the assembled machine config block: server-url / connect-key / optional
 * loopany-cli) are both passed in from the modal that renders them, so the single-template
 * and bundle snippets share ONE source and can't desync. English only.
 */
export function buildBundlePrompt({
  instruction,
  configLines,
  bundle,
}: {
  instruction: string
  configLines: string
  bundle: BundleView
}): string {
  const { label, members } = bundle
  const n = members.length
  const preamble = [
    instruction,
    '',
    `I want to set up scheduled Loopany loops for THIS project, from the "${label}" bundle. Below are ${n} candidate loops. First, look at this project - its stack, tooling, and what's actually observable here - and tell me which are genuinely worth running here and which don't fit, one line of reasoning each. Then help me set up only the ones I confirm, one at a time, following each loop's setup below. Propose cadence and config and confirm before creating each; never create a blind loop.`,
  ].join('\n')

  const menu = [
    `Candidate loops in "${label}":`,
    ...members.map((m, i) => `${i + 1}. ${m.label} - ${m.desc}`),
  ].join('\n')

  const setups = members.map((m) => `[${m.label}]\n${m.description.trim()}`).join('\n\n')

  return [
    preamble,
    '',
    configLines,
    '',
    menu,
    '',
    '- Full setup for each (follow only the ones I confirm) -',
    '',
    setups,
  ].join('\n')
}
