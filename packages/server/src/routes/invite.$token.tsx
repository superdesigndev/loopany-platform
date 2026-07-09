import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { redeemTeamInvite } from '../server/teamFns'
import { authClient, useSession } from '../lib/auth-client'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'
import { setActiveTeamCookie } from '../lib/teamCookie'
import { btnPrimary } from '../components/ui'
import { LoopLogo } from '../components/LoopLogo'

/**
 * Invite-link redeem (`/invite/<token>`, design §4 option B). The recipient opens
 * the link the owner shared; if signed out (under the gate) they hit the normal
 * gated GitHub sign-in and return here — the invite NEVER bypasses the login
 * allowlist (decision 3), it only grants membership once they already have an
 * account. On redeem we navigate to the team's dashboard.
 *
 * Open mode has no identities, so an invite is meaningless there — it renders a
 * calm explanation rather than a broken redeem.
 */
export const Route = createFileRoute('/invite/$token')({
  ssr: false,
  loader: async ({ params }): Promise<{ auth: { enabled: boolean }; token: string; signedIn: boolean }> => {
    const auth = await getAuthState()
    let signedIn = false
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      signedIn = !!session
    }
    return { auth, token: params.token, signedIn }
  },
  component: RedeemInvite,
  errorComponent: LoadError,
})

function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't open this invite." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-32 max-w-sm text-center">
      <LoopLogo size={52} />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-display">Team invite</h1>
      {children}
    </div>
  )
}

function RedeemInvite() {
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  const navigate = useNavigate()
  const [state, setState] = useState<'idle' | 'redeeming' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const ran = useRef(false)

  const gateOn = loaded.auth.enabled
  const signedIn = gateOn ? !!session : false

  useEffect(() => {
    // Redeem exactly once, only when signed in under the gate. Single-use: burning
    // the link is the intended effect, so the ran-once ref prevents a double fire.
    if (!gateOn || isPending || !signedIn || ran.current) return
    ran.current = true
    setState('redeeming')
    void (async () => {
      const r = await redeemTeamInvite({ data: loaded.token })
      if (r.ok) {
        setActiveTeamCookie(r.teamId)
        void navigate({ to: '/t/$teamId', params: { teamId: r.teamId } })
        return
      }
      setMessage(r.error)
      setState('error')
    })()
  }, [gateOn, isPending, signedIn, loaded.token, navigate])

  if (!gateOn) {
    return (
      <Shell>
        <p className="mt-2 text-sm text-secondary">
          This adScaile server runs in open mode (a single shared workspace), so team invites don't apply here.
        </p>
        <button className={`${btnPrimary} mt-6`} onClick={() => void navigate({ to: '/' })}>
          Go to the dashboard
        </button>
      </Shell>
    )
  }

  if (!isPending && !signedIn) {
    // Send them through the gated sign-in and back to this exact invite link.
    return <SignIn callbackURL={`/invite/${loaded.token}`} />
  }

  if (state === 'error') {
    return (
      <Shell>
        <p className="mt-3 text-sm text-accent">{message}</p>
        <button className={`${btnPrimary} mt-6`} onClick={() => void navigate({ to: '/' })}>
          Go to the dashboard
        </button>
      </Shell>
    )
  }

  return (
    <Shell>
      <p className="mt-2 text-sm text-secondary">Joining the team…</p>
    </Shell>
  )
}
