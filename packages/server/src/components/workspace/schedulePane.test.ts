import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE CLOCK'S TWO UI SURFACES, pinned at the source.
 *
 * Both are cheap to break silently, and neither has a runtime assertion that would
 * catch it:
 *
 *  1. the SCHEDULE pane. Adding a pane means moving THREE things together - the view
 *     name, the fetch in `refresh`, and the sidebar entry - and a pane wired into
 *     two of the three renders nothing while looking perfectly plausible in the diff.
 *  2. the CLOCK timeline row. `classify` returns a `clock` kind, `Glyph` needs a
 *     glyph for it, and the stylesheet needs `.event-clock` - miss the last one and a
 *     clock event renders as the default grey dot, which is exactly the "a fire looks
 *     like the run it caused" confusion the row type exists to end.
 *
 * Source-reading guards keep the path in a VARIABLE: vite statically rewrites the
 * literal `new URL('./x', import.meta.url)` form into an asset URL, which
 * `fileURLToPath` then rejects (see the repo's CLAUDE.md).
 */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

describe('the Schedule pane is wired into all three places a pane needs', () => {
  const source = read('./WorkspaceView.tsx')

  it('declares the view, fetches it, and offers it in the sidebar', () => {
    expect(source).toMatch(/type ViewName =[^\n]*'schedule'/)
    expect(source).toContain('fetchSchedule()')
    expect(source).toContain("{ id: 'schedule', label: 'Schedule' }")
    expect(source).toContain("view === 'schedule' && schedule && <SchedulePane")
    // Deep-linkable, like the other panes.
    expect(source).toContain("requested === 'schedule'")
  })

  it('says out loud when a cadence is configured but not armed', () => {
    // The distinction the pane exists for. A row that showed "every day at 07:00"
    // without saying the clock is not on it would be telling a person about
    // something that is not happening.
    expect(source).toContain('configured, not armed on this server')
    expect(source).toContain('is the scheduler running?')
  })
})

describe('a clock event has its own timeline row', () => {
  it('carries a glyph and a stylesheet rule, not just a kind', () => {
    const view = read('./WorkspaceView.tsx')
    const api = read('./api.ts')
    const css = read('../../styles/workspace.css')
    expect(api).toMatch(/kind: 'decision' \| 'artifact' \| 'observe' \| 'run' \| 'clock'/)
    expect(view).toMatch(/^\s*clock: /m)
    expect(css).toContain('.event-clock')
  })
})
