import type { ReactNode } from 'react'

/**
 * Per-template icon registry — one small mark per template, shown on the market card
 * and the detail header. Brand-backed templates draw their REAL mark in its brand
 * color (Reddit snoo, React atom, Homebrew mug — same rule as the thumb.svg SOP:
 * a brand logo in its real color, never a generic centered icon); everything else
 * gets a matched line glyph in `currentColor`, so it inherits the text ink.
 *
 * Inline SVG on purpose: the market SSRs, ships no icon font, and the strict CSP
 * story means no external sprite. A template without an entry falls back to the
 * loop glyph rather than rendering nothing.
 */
export function TemplateIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const brand = BRAND[name]
  if (brand) return brand(size, className)
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {STROKE[name] ?? FALLBACK}
    </svg>
  )
}

/* ── Brand marks (real colors) ─────────────────────────────────────────── */

const BRAND: Record<string, (size: number, className?: string) => ReactNode> = {
  // Reddit snoo, simplified: antenna, ears, head, white eyes + smile.
  'reddit-karma': (size, className) => (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M12 7 16.6 5.2" stroke="#FF4500" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <circle cx="17.7" cy="4.8" r="1.7" fill="#FF4500" />
      <circle cx="4.3" cy="12.4" r="2.2" fill="#FF4500" />
      <circle cx="19.7" cy="12.4" r="2.2" fill="#FF4500" />
      <ellipse cx="12" cy="14.6" rx="8.1" ry="6.6" fill="#FF4500" />
      <circle cx="9" cy="13.9" r="1.3" fill="#fff" />
      <circle cx="15" cy="13.9" r="1.3" fill="#fff" />
      <path d="M8.7 17.2c1 1 2.2 1.5 3.3 1.5s2.3-.5 3.3-1.5" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  ),
  // React atom in the docs-site blue (readable on white, unlike the pale cyan).
  'react-doctor': (size, className) => (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="2.1" fill="#149ECA" />
      <g fill="none" stroke="#149ECA" strokeWidth="1.3">
        <ellipse cx="12" cy="12" rx="10.5" ry="4.2" />
        <ellipse cx="12" cy="12" rx="10.5" ry="4.2" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="10.5" ry="4.2" transform="rotate(120 12 12)" />
      </g>
    </svg>
  ),
  // Homebrew's amber tankard.
  'homebrew-updater': (size, className) => (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#F9A13C"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M7 6h8v13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z" />
      <path d="M15 9h1.5a2.75 2.75 0 0 1 0 5.5H15" />
      <path d="M7 6c0-1.7 1.8-3 4-3s4 1.3 4 3" />
      <path d="M10 10v7M12.5 10v7" strokeWidth="1.3" />
    </svg>
  ),
}

/* ── Line glyphs (currentColor) ────────────────────────────────────────── */

const STROKE: Record<string, ReactNode> = {
  // Growth
  'market-research': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  'seo-try-keywords': (
    <>
      <path d="M22 7 13.5 15.5l-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  'seo-scale-keywords': (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </>
  ),
  'changelog-broadcaster': (
    <>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  // Business Ops
  'support-triage': (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="m4.93 4.93 4.24 4.24m5.66 0 4.24-4.24m0 14.14-4.24-4.24m-5.66 0-4.24 4.24" />
    </>
  ),
  'metrics-digest': (
    <>
      <path d="M3 3v18h18" />
      <path d="M18 17V9M13 17V5M8 17v-3" />
    </>
  ),
  'funnel-watch': <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
  // Personal
  'morning-briefing': (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
    </>
  ),
  'daily-lesson': (
    <>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </>
  ),
  // Codebase Autopilot
  'docs-sweep': (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4M16 13H8m8 4H8m2-8H8" />
    </>
  ),
  'error-sweep': (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4m0 4h.01" />
    </>
  ),
  housekeeper: (
    <>
      <path d="M9.94 15.5 8.5 21.6l-1.44-6.1L1 14.06l6.06-1.44L8.5 6.5l1.44 6.12L16 14.06z" transform="translate(0 -2)" />
      <path d="M19 3v4m2-2h-4" />
      <path d="M19 15v4m2-2h-4" />
    </>
  ),
  'dependency-triage': (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  // CI, Test & Security
  'test-guardian': (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  'security-sweep': (
    <>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  'ci-doctor': <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  // Goal Loops
  'follow-up-tracker': (
    <>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'outcome-watch': (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  'bug-vigil': (
    <>
      <path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1" />
      <path d="M18 11a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v3a6 6 0 0 0 12 0z" />
      <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5m3 8H2m4.8 4C4.7 17.1 3 18.9 3 21M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4m-.8 4c2.1.1 3.8 1.9 3.8 4" />
    </>
  ),
  'release-shepherd': (
    <>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" />
    </>
  ),
}

/** Unknown template → the loop glyph, never an empty gap. */
const FALLBACK = (
  <>
    <path d="M21 12a9 9 0 1 1-9-9" />
    <path d="m17 3 4 0 0 4" />
    <path d="M21 3 12 12" />
  </>
)
