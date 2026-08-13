import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { LoopLogo } from '../components/LoopLogo'
import { btn, btnPrimary, inputCls, labelCls } from '../components/ui'
import { authClient, useSession } from '../lib/auth-client'

type AuthMode = 'loading' | 'shared-password' | 'github' | 'open'
type FlowState = 'entry' | 'confirm' | 'done'

export const Route = createFileRoute('/device')({ component: DeviceApproval })

function DeviceApproval() {
  const { data: session, isPending } = useSession()
  const initial = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('user_code') ?? ''
  const [code, setCode] = useState(initial)
  const [state, setState] = useState<FlowState>('entry')
  const [error, setError] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode>('loading')
  const normalized = code.trim().replaceAll('-', '').toUpperCase()

  useEffect(() => {
    void fetch('/api/auth-mode')
      .then(async (response) => response.json() as Promise<{ mode?: AuthMode }>)
      .then((value) => setAuthMode(value.mode ?? 'open'))
      .catch(() => setAuthMode('open'))
  }, [])

  const verify = async () => {
    setError('')
    const result = await authClient.device({ query: { user_code: normalized } })
    if (result.error) setError(result.error.error_description ?? 'This code is invalid or has expired.')
    else setState('confirm')
  }

  const decide = async (approve: boolean) => {
    setError('')
    const result = approve
      ? await authClient.device.approve({ userCode: normalized })
      : await authClient.device.deny({ userCode: normalized })
    if (result.error) setError(result.error.error_description ?? 'The request could not be completed.')
    else setState('done')
  }

  const step = state === 'entry' ? 2 : state === 'confirm' ? 3 : 3
  return (
    <main className="min-h-screen px-5 py-10 sm:py-16">
      <section className="mx-auto max-w-[620px] overflow-hidden rounded-card border border-wire bg-surface shadow-[0_20px_70px_rgba(0,0,0,0.08)]">
        <header className="flex items-center justify-between border-b border-wire px-6 py-5 sm:px-8">
          <div className="flex items-center gap-3">
            <LoopLogo size={30} />
            <span className="font-pixel text-[17px] text-display">LOOPANY KERNEL</span>
          </div>
          <span className="font-mono text-meta uppercase tracking-[0.16em] text-secondary">Device link</span>
        </header>

        <div className="px-6 py-8 sm:px-8 sm:py-10">
          <p className="font-mono text-label uppercase tracking-[0.18em] text-secondary">CLI authorization</p>
          <h1 className="mt-3 font-pixel text-[clamp(26px,6vw,36px)] leading-[1.12] text-display">Connect this terminal</h1>
          <p className="mt-4 max-w-[500px] text-body leading-relaxed text-secondary">
            Confirm the code shown by <span className="font-mono text-primary">lk setup</span>. Approval signs the CLI in as you; it does not share your password with the terminal.
          </p>

          <ol className="mt-7 grid grid-cols-3 border-y border-wire py-4" aria-label="Authorization progress">
            {['Sign in', 'Check code', 'Approve'].map((label, index) => {
              const n = index + 1
              const active = session?.user ? n <= step : n === 1
              return <li key={label} className={`font-mono text-meta uppercase tracking-[0.08em] ${active ? 'text-display' : 'text-disabled'}`}>
                <span className="mr-1.5">{String(n).padStart(2, '0')}</span>{label}
              </li>
            })}
          </ol>

          {isPending || authMode === 'loading' ? <p className="mt-8 text-body text-secondary">Checking your session…</p>
            : !session?.user ? <SignInPanel mode={authMode} code={normalized} onError={setError} />
              : <ApprovalPanel sessionEmail={session.user.email} code={code} normalized={normalized} state={state} setCode={setCode} verify={verify} decide={decide} />}

          {error && <p role="alert" className="mt-5 border-l-2 border-danger bg-danger-soft px-4 py-3 text-body text-danger">{error}</p>}
        </div>
      </section>
    </main>
  )
}

function SignInPanel({ mode, code, onError }: { mode: AuthMode; code: string; onError: (message: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const callbackURL = `/device?user_code=${encodeURIComponent(code)}`

  const sharedLogin = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); onError('')
    try {
      const response = await fetch('/api/auth/kernel-shared-login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
      })
      if (!response.ok) { onError('Invalid email or access password.'); return }
      window.location.assign(callbackURL)
    } catch { onError('The server could not be reached.') }
    finally { setBusy(false) }
  }

  if (mode === 'github') return <div className="mt-8">
    <p className="text-body text-secondary">Sign in before approving this terminal.</p>
    <button className={`${btnPrimary} mt-5`} onClick={() => void authClient.signIn.social({ provider: 'github', callbackURL })}>Continue with GitHub</button>
  </div>
  if (mode === 'open') return <div className="mt-8 rounded-card border border-wire bg-paper px-5 py-4 text-body leading-relaxed text-secondary">
    Device approval requires authentication. Start the local server in <span className="font-mono text-primary">shared-password</span> mode, then reload this page.
  </div>
  return <form className="mt-8 space-y-5" onSubmit={sharedLogin}>
    <p className="text-body text-secondary">Use the same account you use in the Kernel workspace.</p>
    <label className={labelCls}>Email<input className={`${inputCls} mt-2`} autoFocus type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <label className={labelCls}>Access password<input className={`${inputCls} mt-2`} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <button className={btnPrimary} disabled={busy}>{busy ? 'Signing in…' : 'Sign in and continue'}</button>
  </form>
}

function ApprovalPanel({ sessionEmail, code, normalized, state, setCode, verify, decide }: {
  sessionEmail: string; code: string; normalized: string; state: FlowState; setCode: (value: string) => void
  verify: () => Promise<void>; decide: (approve: boolean) => Promise<void>
}) {
  if (state === 'done') return <div className="mt-8 rounded-card border border-success bg-success-soft px-5 py-5">
    <p className="font-medium text-success">Terminal connected</p><p className="mt-1 text-body text-secondary">Return to your terminal. Setup will continue automatically.</p>
  </div>
  if (state === 'confirm') return <div className="mt-8">
    <p className="text-body text-secondary">Allow this CLI session to act as <strong className="text-display">{sessionEmail}</strong>?</p>
    <div className="mt-6 flex flex-wrap gap-3"><button className={btnPrimary} onClick={() => void decide(true)}>Approve terminal</button><button className={btn} onClick={() => void decide(false)}>Deny</button></div>
  </div>
  return <div className="mt-8">
    <p className="text-body text-secondary">Signed in as <strong className="text-display">{sessionEmail}</strong></p>
    <label className={`${labelCls} mt-5`}>Device code<input className={`${inputCls} mt-2 font-mono text-[20px] uppercase tracking-[0.14em]`} aria-label="Device code" value={code} onChange={(event) => setCode(event.target.value)} /></label>
    <button className={`${btnPrimary} mt-5`} disabled={!normalized} onClick={() => void verify()}>Check this code</button>
  </div>
}
