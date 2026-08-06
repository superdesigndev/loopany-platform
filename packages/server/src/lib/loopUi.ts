import DOMPurify, { type Config } from 'dompurify'

import type { RunSummary } from '../types'
import { buildBindingContext, resolveBindings } from './binding'

/** Custom elements understood by both loop-dashboard renderers. */
export const LOOP_UI_TAGS = ['loop-chart', 'loop-tabs'] as const

/** Data-only attributes carried by the custom elements above. */
export const LOOP_UI_ATTRS = ['series', 'tabs'] as const

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'p', 'b', 'strong', 'i', 'em', 'u', 's', 'span', 'div',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'code', 'pre', 'br',
    'hr', 'small', 'section', 'header', 'footer', 'a', 'figure', 'figcaption', 'mark',
    ...LOOP_UI_TAGS,
  ],
  ALLOWED_ATTR: ['style', 'class', 'href', 'title', 'target', 'rel', ...LOOP_UI_ATTRS],
  ADD_TAGS: [...LOOP_UI_TAGS],
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: new RegExp(`^(?:${LOOP_UI_TAGS.join('|')})$`),
    attributeNameCheck: new RegExp(`^(?:${LOOP_UI_ATTRS.join('|')})$`),
    allowCustomizedBuiltInElements: false,
  },
}

// Data-bearing values such as `series="cpu:CPU:%, inlet:Temp:C"` contain
// punctuation DOMPurify would otherwise erase. They are parsed as
// data by our React replacements and never re-enter markup, so preserve them.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  const tag = node.nodeName?.toLowerCase()
  if (tag && (LOOP_UI_TAGS as readonly string[]).includes(tag) && (LOOP_UI_ATTRS as readonly string[]).includes(data.attrName)) {
    data.forceKeepAttr = true
  }
})

/**
 * The single sanitizer/binding seam for agent-authored loop dashboards.
 *
 * Both the shipping loop page and the converged workspace call this function:
 * scalar bindings are HTML-escaped first, then the same allowlist removes
 * scripts, event handlers, raw SVG and every unknown custom element.
 */
export function sanitizeLoopUi(html: string, runs: RunSummary[]): string {
  return DOMPurify.sanitize(resolveBindings(html, buildBindingContext(runs)), SANITIZE_CONFIG)
}
