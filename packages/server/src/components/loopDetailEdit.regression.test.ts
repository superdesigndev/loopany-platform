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
 * "Claude Code". The per-loop AGENT_LABEL chip (the ACTUAL recorded agent) is
 * exempt — it is a factual label, not generic copy.
 */
describe('agent-neutral edit copy', () => {
  it('never hardcodes "Claude Code" in generic edit prose', () => {
    // strip the AGENT_LABEL map + its fallback default (the factual per-loop chip)
    const generic = src.replace(/AGENT_LABEL[^\n]*Claude Code[^\n]*\n/g, '').replace(/\?\?\s*'Claude Code'/g, '')
    expect(generic).not.toMatch(/Claude Code/)
    expect(formSrc).not.toMatch(/Claude Code/)
  })

  it('uses agent-neutral wording for the dispatch composer', () => {
    expect(src).toMatch(/Edit with your coding agent/)
    expect(src).toMatch(/Dispatch to your coding agent/)
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
