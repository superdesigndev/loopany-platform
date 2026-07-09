import { useRef, useState } from 'react'
import { signIn } from '../lib/auth-client'
import { LoopLogo } from './LoopLogo'
import { LoopPlaybook } from './LoopPlaybook'
import { DISCORD_URL, DiscordIcon, GITHUB_URL, GitHubIcon } from './SocialLinks'
import { btnPrimary } from './ui'

/**
 * Sign-in CTA — shown by the auth gate when a GitHub OAuth app is configured and
 * the visitor has no session. `callbackURL` returns the user to where they were
 * (the dashboard by default, or the deep-linked loop/run page) after the OAuth
 * round-trip, so a logged-out deep link lands back on the page it was for.
 *
 * The playbook band renders below the card as the signed-out pitch; its
 * "Start a loop" CTA scrolls back up to this card (with a brief highlight)
 * so the path to signing in is obvious.
 */
export function SignIn({ callbackURL = '/' }: { callbackURL?: string }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState(false)
  const scrollToSignIn = () => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHint(true)
    setTimeout(() => setHint(false), 1800)
  }
  return (
    <main className="mx-auto max-w-[1180px] px-8 pb-24">
      <div
        ref={cardRef}
        className={`mx-auto mt-32 max-w-sm rounded-card p-6 text-center transition-shadow duration-500 ${
          hint ? 'shadow-[0_0_0_2px_var(--color-surface),0_0_0_4px_var(--color-interactive)]' : ''
        }`}
      >
        <LoopLogo size={52} />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-display">Loopany</h1>
        <p className="mt-2 text-sm text-secondary">Sign in to manage your scheduled agent loops.</p>
        <button
          className={`${btnPrimary} mt-6`}
          onClick={() => void signIn.social({ provider: 'github', callbackURL })}
        >
          Continue with GitHub
        </button>
        <div className="mt-5 flex items-center justify-center gap-5 text-caption text-secondary">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-display">
            <GitHubIcon className="size-4" /> Open source
          </a>
          <a href={DISCORD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-display">
            <DiscordIcon className="size-4" /> Discord
          </a>
        </div>
      </div>
      <LoopPlaybook onStart={scrollToSignIn} />
    </main>
  )
}
