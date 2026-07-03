import { signIn } from '../lib/auth-client'
import { LoopLogo } from './LoopLogo'
import { btnPrimary } from './ui'

/**
 * Sign-in CTA — shown by the auth gate when a GitHub OAuth app is configured and
 * the visitor has no session. `callbackURL` returns the user to where they were
 * (the dashboard by default, or the deep-linked loop/run page) after the OAuth
 * round-trip, so a logged-out deep link lands back on the page it was for.
 */
export function SignIn({ callbackURL = '/' }: { callbackURL?: string }) {
  return (
    <div className="mx-auto mt-32 max-w-sm text-center">
      <LoopLogo size={52} />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-display">Loopany</h1>
      <p className="mt-2 text-sm text-secondary">Sign in to manage your scheduled agent loops.</p>
      <button
        className={`${btnPrimary} mt-6`}
        onClick={() => void signIn.social({ provider: 'github', callbackURL })}
      >
        Continue with GitHub
      </button>
    </div>
  )
}
