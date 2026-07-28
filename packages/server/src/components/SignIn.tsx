import { useEffect, useRef, useState } from 'react'
import { signIn } from '../lib/auth-client'
import { listPublicBundles } from '../server/loopApi'
import type { BundleView } from '../types'
import { LoopLogo } from './LoopLogo'
import { LoopPlaybook } from './LoopPlaybook'
import { TemplatesPreview } from './TemplatesPreview'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'
import { btnPrimary } from './ui'

/**
 * The PRE-LOGIN landing — shown by the auth gate on every gated route when a GitHub
 * OAuth app is configured and the visitor has no session. `callbackURL` returns the
 * user to where they were (the dashboard by default, or the deep-linked loop/run
 * page) after the OAuth round-trip, so a logged-out deep link lands back on the page
 * it was for.
 *
 * It is a modest landing, not a bare card: value line + sign-in CTA, then the SAME
 * template-catalog teaser the dashboard shows (shared `TemplateCard`, fading out into
 * "Browse all templates"), then the playbook band as the pitch. Both bands' CTAs
 * scroll back to the sign-in card (with a brief highlight), so the path in stays
 * obvious however far the visitor reads.
 *
 * The teaser reads the PUBLIC registry (`listPublicBundles` — thumb-stripped, no
 * membership scoping), fetched here rather than threaded through the eight gated
 * routes that render this component. `/templates` is public too, so every link the
 * cards carry works logged out. Best-effort: a failed fetch just leaves the band out
 * (`TemplatesPreview` renders nothing for an empty registry), never the sign-in path.
 */
export function SignIn({ callbackURL = '/' }: { callbackURL?: string }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState(false)
  const [bundles, setBundles] = useState<BundleView[]>([])

  useEffect(() => {
    let alive = true
    void listPublicBundles()
      .then((b) => {
        if (alive) setBundles(b)
      })
      .catch(() => {
        /* the teaser is a nice-to-have; signing in never depends on it */
      })
    return () => {
      alive = false
    }
  }, [])

  const scrollToSignIn = () => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHint(true)
    setTimeout(() => setHint(false), 1800)
  }

  return (
    <main className="mx-auto max-w-[1180px] px-8 pb-24">
      <section className="pt-24 text-center">
        <LoopLogo size={52} />
        <h1 className="mx-auto mt-5 max-w-[640px] font-pixel text-[clamp(28px,4.5vw,38px)] leading-[1.15] text-display">
          What should happen while you sleep?
        </h1>
        <p className="mx-auto mt-4 max-w-[560px] text-body leading-relaxed text-secondary">
          Loopany runs scheduled agent loops on your own machine with your own coding agent. It keeps the schedule, the
          history and the notifications — it never runs an LLM or your code itself.
        </p>
        <div
          ref={cardRef}
          className={`mx-auto mt-8 inline-block rounded-card px-6 py-5 transition-shadow duration-500 ${
            hint ? 'shadow-[0_0_0_2px_var(--color-surface),0_0_0_4px_var(--color-interactive)]' : ''
          }`}
        >
          <button className={btnPrimary} onClick={() => void signIn.social({ provider: 'github', callbackURL })}>
            Continue with GitHub
          </button>
          <p className="mt-3 text-caption text-disabled">Browsing the templates below needs no account.</p>
        </div>
        <div className="mt-5 flex items-center justify-center gap-5 text-caption text-secondary">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-display">
            <GitHubIcon className="size-4" /> Open source
          </a>
          <a href={DISCORD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-display">
            <DiscordIcon className="size-4" /> Discord
          </a>
        </div>
      </section>

      <TemplatesPreview bundles={bundles} />

      <LoopPlaybook onStart={scrollToSignIn} />
    </main>
  )
}
