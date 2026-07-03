import { signIn } from '../lib/auth-client'
import { LoopLogo } from './LoopLogo'

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
      <h1 className="mt-4 font-mono text-2xl tracking-tight">Loopany</h1>
      <p className="mt-2 text-sm text-secondary">Sign in to manage your scheduled agent loops.</p>
      <button
        className="mt-6 rounded-md bg-primary px-4 py-2 text-sm text-paper"
        onClick={() => void signIn.social({ provider: 'github', callbackURL })}
      >
        Continue with GitHub
      </button>
    </div>
  )
}
