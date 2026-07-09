import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { createTheme } from '@uiw/codemirror-themes'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'

/**
 * CodeMirror-backed code field for the manual settings form (workflow JS /
 * metrics JSON / dashboard HTML). Lives in its OWN lazy chunk - LoopForm
 * `lazy()`-imports it, so CodeMirror never rides in the base client bundle
 * (same discipline as the recharts-bearing LoopView chunk).
 *
 * Theming: every color is a CSS variable from app.css, so the editor tracks
 * light/dark via the same `prefers-color-scheme` media query as the rest of
 * the UI - no JS mode detection, no theme swap. The syntax palette maps onto
 * the Rubik semantic inks (keyword/tag = interactive blue, string = success
 * green, number = warn orange, comment = disabled gray).
 */
const adscaileTheme = createTheme({
  theme: 'light', // base defaults only; every visible color below is a CSS var
  settings: {
    background: 'var(--color-raised)',
    foreground: 'var(--color-primary)',
    caret: 'var(--color-display)',
    selection: 'var(--color-interactive-soft)',
    selectionMatch: 'var(--color-interactive-soft)',
    lineHighlight: 'transparent',
    gutterBackground: 'var(--color-raised)',
    gutterForeground: 'var(--color-disabled)',
    gutterActiveForeground: 'var(--color-secondary)',
    gutterBorder: 'transparent',
    fontFamily: 'var(--font-mono)',
  },
  styles: [
    { tag: t.comment, color: 'var(--color-disabled)', fontStyle: 'italic' },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.self], color: 'var(--color-interactive)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--color-success)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-warn)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--color-primary)', fontWeight: '500' },
    { tag: t.tagName, color: 'var(--color-interactive)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-display)' },
    { tag: t.variableName, color: 'var(--color-primary)' },
    { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--color-secondary)' },
    { tag: t.invalid, color: 'var(--color-accent)' },
  ],
})

/** Type scale + focus/padding polish on top of the theme (sizes are not
 *  `createTheme` settings). The focus ring lives on the wrapper, so the
 *  editor's own outline is silenced. */
const sizing = EditorView.theme({
  '&': { fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0' },
  '.cm-gutters': { paddingLeft: '4px' },
  '.cm-placeholder': { color: 'var(--color-disabled)' },
})

const LANG = {
  js: () => javascript(),
  json: () => json(),
  html: () => html(),
} as const

export default function CodeField({
  lang,
  value,
  onChange,
  placeholder,
  minHeight,
  maxHeight = '480px',
  invalid,
}: {
  lang: keyof typeof LANG
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minHeight: string
  maxHeight?: string
  invalid?: boolean
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-control border bg-raised transition-shadow focus-within:shadow-focus ${
        invalid ? 'border-accent' : 'border-wire focus-within:border-transparent'
      }`}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        theme={adscaileTheme}
        // Soft-wrap long lines: these fields hold config-sized snippets with
        // long attribute strings; wrapping beats a nested horizontal scroll.
        extensions={[LANG[lang](), sizing, EditorView.lineWrapping]}
        minHeight={minHeight}
        maxHeight={maxHeight}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          highlightSelectionMatches: false,
          autocompletion: false,
          searchKeymap: false,
        }}
      />
    </div>
  )
}
