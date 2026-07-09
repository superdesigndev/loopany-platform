import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the detail-page Edit error.
 *
 * `ModalHead` renders Base UI `Dialog.Title` / `Dialog.Close`, which call
 * `useDialogRootContext()` and throw ("Cannot destructure property 'store' of
 * 'useDialogRootContext(...)' as it is undefined.") when rendered outside a
 * `Dialog.Root`. The loop detail page (`LoopDetailView`) is a plain page — its
 * edit modes are in-page takeovers, NOT modals — so it must use the bare-page
 * `EditHead` heading, never `ModalHead`. Clicking Edit used to import + render
 * `ModalHead` here and crash the page on the first click.
 */
const src = readFileSync(fileURLToPath(new URL('./LoopDetailView.tsx', import.meta.url)), 'utf8')
const formSrc = readFileSync(fileURLToPath(new URL('./LoopForm.tsx', import.meta.url)), 'utf8')
const runSrc = readFileSync(fileURLToPath(new URL('./RunView.tsx', import.meta.url)), 'utf8')
const actionUiSrc = readFileSync(fileURLToPath(new URL('./actionUi.tsx', import.meta.url)), 'utf8')

describe('LoopDetailView edit-mode heading', () => {
  it('does not import or render the Dialog-based ModalHead on the bare page', () => {
    expect(src).not.toMatch(/<ModalHead\b/) // no JSX usage
    expect(src).not.toMatch(/import\s*\{[^}]*\bModalHead\b[^}]*\}\s*from\s*['"]\.\/Modal['"]/) // not imported
  })

  it('uses the bare-page EditHead heading for the edit modes', () => {
    expect(src).toMatch(/<EditHead\b/)
    expect(src).toMatch(/function EditHead\b/)
  })
})

/**
 * Loopany runs more than one coding agent (claude-code, codex, more later), so
 * GENERIC edit copy must be agent-neutral ("your coding agent"), never hardcode
 * "Claude Code". The AGENT_LABEL maps (the ACTUAL recorded/selectable agent — the
 * detail-page chip and the LoopForm agent <select> options) are exempt: they are
 * factual labels, not generic copy.
 */
describe('agent-neutral edit copy', () => {
  it('never hardcodes "Claude Code" in generic edit prose', () => {
    // strip the AGENT_LABEL map + its fallback default (the factual per-loop chip)
    const stripAgentLabel = (s: string) => s.replace(/AGENT_LABEL[^\n]*Claude Code[^\n]*\n/g, '').replace(/\?\?\s*'Claude Code'/g, '')
    expect(stripAgentLabel(src)).not.toMatch(/Claude Code/)
    // LoopForm's agent <select> carries the same factual AGENT_LABEL map; only its
    // GENERIC prose must stay agent-neutral.
    expect(stripAgentLabel(formSrc)).not.toMatch(/Claude Code/)
  })

  it('uses agent-neutral wording for the dispatch composer', () => {
    expect(src).toMatch(/Edit with your coding agent/)
    expect(src).toMatch(/Dispatch to your coding agent/)
  })

  it('LoopForm agent hint does not claim every loop still runs via Claude', () => {
    // Codex/Grok are real executors — product copy must not lie that only Claude runs.
    expect(formSrc).not.toMatch(/every loop still runs via Claude/i)
    expect(formSrc).not.toMatch(/Recording-only today/i)
    expect(formSrc).not.toMatch(/Binds claude on the machine/i)
    expect(formSrc).toMatch(/Which coding agent executes this loop on the bound machine/)
  })
})

/**
 * The copy-prompt path: an ADDED option alongside dispatch that copies a
 * ready-to-paste prompt for the owner's OWN local coding agent (no dispatch, no
 * credits). The dispatch path stays.
 */
describe('copy-prompt path', () => {
  it('keeps the dispatch path and adds a Copy prompt affordance', () => {
    expect(src).toMatch(/onRequestEdit/) // dispatch path still wired
    expect(src).toMatch(/copyEditPrompt/) // added copy handler
    expect(src).toMatch(/Copy prompt/) // added button label
    expect(src).toMatch(/buildEditPrompt/) // uses the pure helper
    expect(src).toMatch(/loopDir\(job\.taskFile\)/) // derives the dir from the task file
  })
})

/**
 * The continue-session path: copy a ready-to-paste terminal command that resumes
 * the run's coding-agent session on the owner's machine (BYOA — the server can
 * only hand back the command). Run page = that run's session; loop page = the
 * newest run that has one. The shared button lives in actionUi and uses the
 * pure `buildResumeCommand` helper; UI prose stays agent-neutral (the literal
 * `claude` binary inside the copied command is factual, not prose).
 */
describe('continue-session path', () => {
  it('run page offers Continue agent session for the run itself', () => {
    expect(runSrc).toMatch(/useContinueSession\(/)
    expect(runSrc).toMatch(/label: 'Continue agent session'/)
    expect(runSrc).toMatch(/run\?\.sessionId/)
    expect(runSrc).toMatch(/loopDir\(detail\.job\.taskFile\)/) // dir degrades, never fabricated
  })

  it('loop page offers Continue agent session for the newest run with a session', () => {
    expect(src).toMatch(/useContinueSession\(/)
    expect(src).toMatch(/label: 'Continue agent session'/)
    expect(src).toMatch(/runs\.find\(\(r\) => r\.sessionId\)/) // newest-first pick
  })

  it('the shared affordance copies via the pure buildResumeCommand helper', () => {
    expect(actionUiSrc).toMatch(/function useContinueSession\b/)
    expect(actionUiSrc).toMatch(/buildResumeCommand/)
    expect(actionUiSrc).not.toMatch(/Claude Code/) // prose stays agent-neutral
  })

  it('the button carries the (decorative) agent mark', () => {
    expect(actionUiSrc).toMatch(/function ClaudeCodeMark\b/)
    expect(actionUiSrc).toMatch(/<ClaudeCodeMark \/>/)
    // decorative only — the accessible name stays the agent-neutral label
    expect(actionUiSrc.slice(actionUiSrc.indexOf('function ClaudeCodeMark'))).toMatch(/aria-hidden/)
  })

  it('the paste-it-here instruction renders BELOW the toolbar row, never as a flex sibling', () => {
    // The button sits in flex-wrap toolbars: a conditional full-width sibling
    // reflows the buttons after it (the ⋯ menu jumped to its own line). The hook
    // returns the hint separately, and both pages place it OUTSIDE the row.
    expect(actionUiSrc).toMatch(/return \{ button, hint \}/)
    expect(src).toMatch(/\{continueSession\.hint\}/)
    expect(runSrc).toMatch(/\{continueSession\.hint\}/)
    expect(src).toMatch(/paste it in a terminal|continueSession\.hint/) // hint wired on the loop page
  })
})
