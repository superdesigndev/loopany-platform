import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { BundleView } from '../types'
import { LoopLogo } from './LoopLogo'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'
import { TemplateCard, flattenBundles } from './TemplateCard'

/**
 * The PUBLIC template MARKET (`/templates`) — round-7 text-first redesign (modeled on
 * loops.elorm.xyz). No login (the route runs zero auth checks, so it renders under the
 * gate). No illustration-led cards: each card leads with TEXT — title, a real one-line
 * intro, a category tag, and the three rating chips — plus a "Create in Loopany" deep
 * link and a link to the shareable detail view (`/templates/<slug>`). English only.
 *
 * The card itself lives in the shared `TemplateCard` — the catalog teaser
 * (`TemplatesPreview`, on both the dashboard and the pre-login landing) renders the same
 * one (compact variant), so the surfaces cannot drift.
 */
export function TemplatesPage({ bundles }: { bundles: BundleView[] }) {
  const items = flattenBundles(bundles)
  const [active, setActive] = useState<string>('all')
  const shown = active === 'all' ? items : items.filter((i) => i.categoryName === active)

  return (
    <>
      <PublicHeader />
      <main className="mx-auto max-w-[1180px] px-8 pb-24">
        {/* Compact hero — one-line value prop + one sentence, then straight into the grid. */}
        <section className="pt-14">
          <h1 className="font-pixel text-[clamp(26px,4.4vw,38px)] leading-[1.1] text-display">Pre-built agent loops</h1>
          <p className="mt-3 max-w-[44rem] text-body leading-relaxed text-secondary">
            {items.length} ready-to-run loops that work while you sleep — free to browse. Each is a real prompt you run on
            your own machine with your own coding agent. Open one to read exactly what it does.
          </p>
        </section>

        {/* Category filter. */}
        <div className="mt-8 flex flex-wrap gap-2">
          <FilterChip label="All" count={items.length} active={active === 'all'} onClick={() => setActive('all')} />
          {bundles.map((b) => (
            <FilterChip
              key={b.name}
              label={b.label}
              count={b.members.length}
              active={active === b.name}
              onClick={() => setActive(b.name)}
            />
          ))}
        </div>

        {/* Dense text-first grid. `items-start` lets cards keep their natural height
            (short intros don't get stretched to a tall neighbour). */}
        <div className="mt-6 grid min-w-0 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((it) => (
            <TemplateCard key={it.template.name} item={it} />
          ))}
        </div>

        <p className="mt-16 text-center text-caption text-disabled">
          Every loop runs on your machine via your own coding agent — the server never runs an LLM or your code.
        </p>
      </main>
    </>
  )
}

function FilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-meta font-medium transition-colors ${
        active ? 'bg-display text-paper' : 'border border-hairline bg-surface text-secondary hover:bg-raised hover:text-display'
      }`}
    >
      {label}
      <span className={active ? 'text-paper/70' : 'text-disabled'}>{count}</span>
    </button>
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
