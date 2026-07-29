import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { BundleView } from '../types'
import { LoopLogo } from './LoopLogo'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'
import { TemplateCard, bundleItems } from './TemplateCard'

/**
 * The PUBLIC template MARKET (`/templates`) — marketplace layout (round 9, modeled on
 * the MCP-directory pattern): a centered hero (count badge, stacked pixel headline with
 * a TYPED second line, search, category jump-chips) over per-category SECTIONS, each
 * fully expanded — 21 loops is one comfortable scroll, so there is no View-all or
 * collapse anywhere. No login (the route runs zero auth checks, so it renders under the
 * gate). English only.
 *
 * SSR discipline: the page SSRs for crawlers, so the headline's second line renders the
 * FIRST phrase as static text and the typing loop is a client-only effect (disabled
 * under `prefers-reduced-motion`, same discipline as the bundle carousel). Search is a
 * client-side filter over the already-loaded catalog — no new data path.
 *
 * The card itself lives in the shared `TemplateCard` — the catalog teaser
 * (`TemplatesPreview`, on both the dashboard and the pre-login landing) renders the same
 * one (compact variant), so the surfaces cannot drift. Sections pass
 * `showCategory={false}`: the section header already names the category.
 */
export function TemplatesPage({ bundles }: { bundles: BundleView[] }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const sections = bundles
    .map((b) => ({
      bundle: b,
      items: bundleItems(b).filter(
        (it) =>
          !q ||
          it.template.label.toLowerCase().includes(q) ||
          it.template.desc.toLowerCase().includes(q) ||
          it.template.name.toLowerCase().includes(q) ||
          it.categoryLabel.toLowerCase().includes(q),
      ),
    }))
    .filter((s) => s.items.length > 0)

  return (
    <>
      <PublicHeader />
      <main className="pb-24">
        {/* ── Marketplace hero ─────────────────────────────────────────── */}
        <section className="market-hero px-6 pb-10 pt-16 text-center">
          {/* Both pixel lines at the SAME size; the gray second line types. */}
          {/* One shared size for BOTH lines, derived from the viewport so the LONGEST
              typed phrase stays one line from `sm` up (Geist Pixel runs ~0.83em/char,
              so 3.9vw is the fit coefficient for the 29-char phrase). Below `sm` the
              phrase may wrap at a word break — TypedLine glues the caret to the last
              word, so the caret can never wrap alone (that reads as a bug). */}
          <h1
            aria-label={`Agent loops ${TYPED_PHRASES[0]}`}
            className="mx-auto font-pixel text-[min(56px,3.9vw)] leading-[1.25] text-display max-sm:text-[6.5vw]"
          >
            Agent Loops
            <span aria-hidden className="block text-disabled sm:whitespace-nowrap">
              <TypedLine />
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-[560px] text-body leading-relaxed text-secondary">
            Ready-to-run loops that work while you sleep. Each one is a real prompt — free to read, runs on your own
            machine with your own coding agent.
          </p>

          {/* Client-side search over the loaded catalog. */}
          <div className="mx-auto mt-7 flex max-w-[560px] items-center gap-2.5 rounded-lg border border-wire bg-surface px-4 py-2.5 focus-within:shadow-focus">
            <svg aria-hidden width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-disabled">
              <circle cx="7" cy="7" r="5" />
              <path d="m11 11 3.5 3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search loops — "reddit", "metrics", "tests"…'
              aria-label="Search loops"
              className="w-full bg-transparent font-mono text-caption text-display outline-none placeholder:text-disabled"
            />
          </div>

          {/* Category jump-chips — the sections are all expanded, so these navigate. */}
          <nav aria-label="Categories" className="mx-auto mt-5 flex flex-wrap justify-center gap-2">
            {bundles.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => document.getElementById(sectionId(b.name))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 py-1 font-mono text-meta text-secondary transition-colors hover:bg-raised hover:text-display"
              >
                {b.label}
                <span className="text-disabled">{b.members.length}</span>
              </button>
            ))}
          </nav>
        </section>

        {/* ── Category sections, fully expanded ────────────────────────── */}
        <div className="mx-auto max-w-[1180px] px-8">
          {sections.map(({ bundle: b, items }) => (
            <section key={b.name} id={sectionId(b.name)} className="mt-12 scroll-mt-20 first:mt-4">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[21px] font-semibold tracking-[-0.015em] text-display">{b.label}</h2>
                <span className="text-meta text-disabled">{items.length}</span>
              </div>
              <p className="mt-1 text-caption text-secondary">{b.tagline}</p>
              <div className="mt-4 grid min-w-0 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((it) => (
                  <TemplateCard key={it.template.name} item={it} showCategory={false} />
                ))}
              </div>
            </section>
          ))}
          {sections.length === 0 && (
            <p className="mt-16 text-center text-body text-secondary">No loops match “{query}”.</p>
          )}

          <p className="mt-16 text-center text-caption text-disabled">
            Every loop runs on your machine via your own coding agent — the server never runs an LLM or your code.
          </p>
        </div>
      </main>
    </>
  )
}

const sectionId = (name: string) => `cat-${name}`

/**
 * The typed headline phrases — outcomes, not features. The FIRST is also the SSR
 * static text (crawlers and no-JS read "Agent Loops that actually work").
 */
const TYPED_PHRASES = [
  'that actually work',
  'that automate your business',
  'that maintain your codebase',
  'that fix bugs while you sleep',
  'that grow your audience',
  'that watch your metrics',
]

const TYPE_MS = 55
const DELETE_MS = 26
const HOLD_MS = 1800
const NEXT_PAUSE_MS = 320

/**
 * The typewriter second line. Renders the first phrase statically (SSR + first paint),
 * then a client effect types/deletes through the set with a blinking block caret.
 * `prefers-reduced-motion` leaves the static line in place and never starts the loop.
 */
function TypedLine() {
  const [text, setText] = useState(TYPED_PHRASES[0]!)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let phrase = 0
    let chars = TYPED_PHRASES[0]!.length
    let mode: 'hold' | 'delete' | 'type' = 'hold'
    let timer: ReturnType<typeof setTimeout>
    const step = () => {
      if (mode === 'hold') {
        mode = 'delete'
        timer = setTimeout(step, HOLD_MS)
        return
      }
      if (mode === 'delete') {
        if (chars > 0) {
          chars--
          setText(TYPED_PHRASES[phrase]!.slice(0, chars))
          timer = setTimeout(step, DELETE_MS)
        } else {
          phrase = (phrase + 1) % TYPED_PHRASES.length
          mode = 'type'
          timer = setTimeout(step, NEXT_PAUSE_MS)
        }
        return
      }
      const target = TYPED_PHRASES[phrase]!
      if (chars < target.length) {
        chars++
        setText(target.slice(0, chars))
        timer = setTimeout(step, TYPE_MS)
      } else {
        mode = 'hold'
        timer = setTimeout(step, 0)
      }
    }
    timer = setTimeout(step, HOLD_MS)
    return () => clearTimeout(timer)
  }, [])
  // Glue the caret to the final word: if the line ever wraps (below `sm`), the break
  // lands between words and the caret rides the last word — never alone on its own line.
  const cut = text.lastIndexOf(' ')
  const head = cut === -1 ? '' : text.slice(0, cut + 1)
  const tail = cut === -1 ? text : text.slice(cut + 1)
  return (
    <>
      {head}
      <span className="whitespace-nowrap">
        {tail}
        <span className="type-caret" />
      </span>
    </>
  )
}

/** The quiet public top bar — shared by the market grid and the detail view. */
export function PublicHeader() {
  return (
    <header className="glass glass-bar sticky top-0 z-50">
      <div className="mx-auto flex max-w-[1180px] items-center gap-3 px-8 py-2.5">
        <Link to="/templates" className="flex items-center gap-3">
          <LoopLogo size={30} />
          <span className="text-[18px] font-semibold tracking-[-0.015em] text-display">Loopany</span>
        </Link>
        <span className="ml-1 hidden rounded-full bg-raised px-2.5 py-0.5 text-micro font-medium text-secondary sm:inline">
          Templates
        </span>
        <div className="flex-1" />
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository" title="GitHub" className={headerIconBtn}>
          <GitHubIcon className="size-[17px]" />
        </a>
        <a href={DISCORD_URL} target="_blank" rel="noreferrer" aria-label="Discord community" title="Discord" className={headerIconBtn}>
          <DiscordIcon className="size-[17px]" />
        </a>
        <Link
          to="/"
          className="inline-flex shrink-0 cursor-pointer items-center rounded-full bg-display px-3.5 py-1.5 text-meta font-medium text-paper transition-opacity hover:opacity-85"
        >
          Sign in
        </Link>
      </div>
    </header>
  )
}

const headerIconBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full p-1.5 text-secondary transition-colors hover:bg-raised hover:text-display'
