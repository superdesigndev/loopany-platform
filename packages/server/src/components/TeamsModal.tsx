import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Modal, ModalHead, ModalSection } from './Modal'
import { btn, btnDanger, btnPrimary, btnSm, ErrorBanner, inputCls, labelCls, Pill, selectCls } from './ui'
import { setActiveTeamCookie } from '../lib/teamCookie'
import {
  listManagedTeams,
  getTeamDetail,
  createTeam,
  renameTeam,
  deleteTeam,
  addTeamMember,
  setTeamMemberRole,
  removeTeamMember,
  leaveTeam,
  createTeamInvite,
  revokeTeamInvite,
} from '../server/teamFns'
import type { Role, TeamAdminDetail, TeamAdminSummary } from '../server/teamAdmin'

type Invite = { token: string; role: Role; expiresAt: string }

function inviteUrl(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/invite/${token}`
}

function CopyLink({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={btnSm}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'Copied ✓' : 'Copy link'}
    </button>
  )
}

/**
 * Team settings — the owner-facing surface for the full lifecycle: create,
 * rename, members (add-by-email + role + remove), invite links, leave, and
 * delete (with the blocked-while-loops explanation). A master list of the
 * caller's teams on the left; the selected team's detail below. Every action
 * calls an EXPLICIT-teamId server fn (never the active cookie), so managing team
 * B while the dashboard is on team A works. Owner-only controls are hidden for a
 * plain member (the server re-authorizes regardless).
 */
export function TeamsModal({
  open,
  onClose,
  activeTeamId,
}: {
  open: boolean
  onClose: () => void
  /** The dashboard's current team — deleting it navigates home. */
  activeTeamId?: string
}) {
  const navigate = useNavigate()
  const [teams, setTeams] = useState<TeamAdminSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TeamAdminDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Create-team form.
  const [newName, setNewName] = useState('')
  // Rename field (seeded from the selected team).
  const [renameVal, setRenameVal] = useState('')
  // Add-by-email form.
  const [email, setEmail] = useState('')
  const [addRole, setAddRole] = useState<Role>('member')
  // Invite generation.
  const [inviteRole, setInviteRole] = useState<Role>('member')
  const [freshInvite, setFreshInvite] = useState<string | null>(null)

  const loadTeams = useCallback(async () => {
    try {
      setTeams(await listManagedTeams())
    } catch {
      /* keep what we have */
    }
  }, [])

  const loadDetail = useCallback(async (teamId: string) => {
    const d = await getTeamDetail({ data: teamId })
    if ('error' in d) {
      setErr(d.error)
      setDetail(null)
      return
    }
    setDetail(d)
    setRenameVal(d.name)
  }, [])

  useEffect(() => {
    if (!open) {
      setErr(null)
      setSelected(null)
      setDetail(null)
      setFreshInvite(null)
      return
    }
    void loadTeams()
  }, [open, loadTeams])

  // Load a team's detail when selected.
  useEffect(() => {
    if (!open || !selected) return
    setFreshInvite(null)
    void loadDetail(selected)
  }, [open, selected, loadDetail])

  async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
    setBusy(true)
    setErr(null)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }

  async function doCreate() {
    const name = newName.trim()
    if (!name) return
    await withBusy(async () => {
      const r = await createTeam({ data: name })
      if (!r.ok) return setErr(r.error)
      setNewName('')
      await loadTeams()
      setSelected(r.id) // open the new team so the owner can add members
    })
  }

  async function doRename() {
    if (!detail) return
    const name = renameVal.trim()
    if (!name || name === detail.name) return
    await withBusy(async () => {
      const r = await renameTeam({ data: { teamId: detail.id, name } })
      if (!r.ok) return setErr(r.error)
      await loadTeams()
      await loadDetail(detail.id)
    })
  }

  async function doDelete() {
    if (!detail) return
    await withBusy(async () => {
      const r = await deleteTeam({ data: detail.id })
      if (!r.ok) return setErr(r.error)
      const removed = detail.id
      setSelected(null)
      setDetail(null)
      await loadTeams()
      if (removed === activeTeamId) {
        onClose()
        void navigate({ to: '/' }) // active team is gone — back to the default dashboard
      }
    })
  }

  async function doLeave() {
    if (!detail) return
    await withBusy(async () => {
      const r = await leaveTeam({ data: detail.id })
      if (!r.ok) return setErr(r.error)
      const left = detail.id
      setSelected(null)
      setDetail(null)
      await loadTeams()
      if (left === activeTeamId) {
        onClose()
        void navigate({ to: '/' })
      }
    })
  }

  async function doAdd() {
    if (!detail) return
    const addr = email.trim()
    if (!addr) return
    await withBusy(async () => {
      const r = await addTeamMember({ data: { teamId: detail.id, email: addr, role: addRole } })
      if (!r.ok) return setErr(r.error)
      setEmail('')
      await loadDetail(detail.id)
      await loadTeams()
    })
  }

  async function doSetRole(userId: string, role: Role) {
    if (!detail) return
    await withBusy(async () => {
      const r = await setTeamMemberRole({ data: { teamId: detail.id, userId, role } })
      if (!r.ok) return setErr(r.error)
      await loadDetail(detail.id)
    })
  }

  async function doRemove(userId: string) {
    if (!detail) return
    await withBusy(async () => {
      const r = await removeTeamMember({ data: { teamId: detail.id, userId } })
      if (!r.ok) return setErr(r.error)
      await loadDetail(detail.id)
      await loadTeams()
    })
  }

  async function doInvite() {
    if (!detail) return
    await withBusy(async () => {
      const r = await createTeamInvite({ data: { teamId: detail.id, role: inviteRole } })
      if (!r.ok) return setErr(r.error)
      setFreshInvite(r.token)
      await loadDetail(detail.id)
    })
  }

  async function doRevoke(token: string) {
    if (!detail) return
    await withBusy(async () => {
      const r = await revokeTeamInvite({ data: { teamId: detail.id, token } })
      if (!r.ok) return setErr(r.error)
      if (freshInvite === token) setFreshInvite(null)
      await loadDetail(detail.id)
    })
  }

  const isOwner = detail?.role === 'owner'

  return (
    <Modal open={open} onClose={onClose} wide>
      <ModalHead
        title="Teams"
        sub="Create teams, manage members and roles, and invite people. Team management is owner-only; any member can create loops."
      />

      {err && <ErrorBanner message={err} onDismiss={() => setErr(null)} className="mb-2 mt-3" />}

      <div className="mt-3 grid gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* ---- master: my teams ---- */}
        <div className="min-w-0">
          <ModalSection>My teams</ModalSection>
          {teams.length === 0 && <div className="py-2 text-body text-secondary">No teams yet.</div>}
          <ul className="flex flex-col gap-1.5">
            {teams.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setSelected(t.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-control border px-3 py-2 text-left transition-colors ${
                    selected === t.id ? 'border-display bg-raised' : 'border-hairline bg-surface hover:bg-raised'
                  }`}
                >
                  <span className="min-w-0 truncate text-[15px] font-medium text-display">{t.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Pill tone={t.role === 'owner' ? 'ink' : 'neutral'}>{t.role}</Pill>
                    <span className="text-label text-secondary">
                      {t.memberCount} member{t.memberCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 rounded-control border border-hairline bg-raised px-3 py-3">
            <label className={`${labelCls} mt-0`} htmlFor="team-new-name">New team</label>
            <div className="flex gap-2">
              <input
                id="team-new-name"
                className={inputCls}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Growth Squad"
                onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
              />
              <button className={btnPrimary} disabled={busy || !newName.trim()} onClick={() => void doCreate()}>
                Create
              </button>
            </div>
          </div>
        </div>

        {/* ---- detail: selected team ---- */}
        <div className="min-w-0">
          {!detail ? (
            <div className="flex h-full items-center justify-center py-10 text-body text-secondary">
              Select a team to manage it, or create one.
            </div>
          ) : (
            <>
              <ModalSection
                action={
                  <button
                    className={btnSm}
                    onClick={() => {
                      setActiveTeamCookie(detail.id)
                      onClose()
                      void navigate({ to: '/t/$teamId', params: { teamId: detail.id } })
                    }}
                  >
                    Open dashboard →
                  </button>
                }
              >
                {detail.name}
                {detail.personal ? ' · personal' : ''}
              </ModalSection>

              {/* Rename (owner-only). */}
              {isOwner && (
                <div className="mb-4">
                  <label className={labelCls}>Team name</label>
                  <div className="flex gap-2">
                    <input aria-label="Team name" className={inputCls} value={renameVal} onChange={(e) => setRenameVal(e.target.value)} />
                    <button
                      className={btn}
                      disabled={busy || !renameVal.trim() || renameVal.trim() === detail.name}
                      onClick={() => void doRename()}
                    >
                      Rename
                    </button>
                  </div>
                </div>
              )}

              {/* Members. */}
              <ModalSection>Members</ModalSection>
              <ul className="flex flex-col gap-2">
                {detail.members.map((m) => (
                  <li
                    key={m.userId}
                    className="flex items-center justify-between gap-3 rounded-control border border-hairline bg-surface px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[15px] font-medium text-display">
                        {m.email ?? m.displayName ?? m.userId}
                        {m.isSelf && <span className="ml-1.5 text-label text-secondary">(you)</span>}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isOwner && !m.isSelf ? (
                        <>
                          <select
                            aria-label="Role"
                            className={`${selectCls} w-auto py-1.5`}
                            value={m.role}
                            onChange={(e) => void doSetRole(m.userId, e.target.value as Role)}
                          >
                            <option value="owner">owner</option>
                            <option value="member">member</option>
                          </select>
                          <button className={btnDanger} disabled={busy} onClick={() => void doRemove(m.userId)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <Pill tone={m.role === 'owner' ? 'ink' : 'neutral'}>{m.role}</Pill>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              {/* Add + invite (owner-only). */}
              {isOwner && (
                <>
                  <div className="mt-4 rounded-control border border-hairline bg-raised px-3 py-3">
                    <label className={`${labelCls} mt-0`} htmlFor="team-add-email">Add a member by email</label>
                    <div className="flex flex-wrap gap-2">
                      <input
                        id="team-add-email"
                        className={`${inputCls} min-w-[12rem] flex-1`}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="teammate@example.com"
                        onKeyDown={(e) => e.key === 'Enter' && void doAdd()}
                      />
                      <select
                        aria-label="Role for new member"
                        className={`${selectCls} w-auto`}
                        value={addRole}
                        onChange={(e) => setAddRole(e.target.value as Role)}
                      >
                        <option value="member">member</option>
                        <option value="owner">owner</option>
                      </select>
                      <button className={btnPrimary} disabled={busy || !email.trim()} onClick={() => void doAdd()}>
                        Add
                      </button>
                    </div>
                    <div className="mt-1.5 text-label text-secondary">
                      Adds an existing Loopany account immediately. No account yet? Generate an invite link below.
                    </div>
                  </div>

                  <ModalSection>Invite links</ModalSection>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Invite role"
                      className={`${selectCls} w-auto`}
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as Role)}
                    >
                      <option value="member">as member</option>
                      <option value="owner">as owner</option>
                    </select>
                    <button className={btn} disabled={busy} onClick={() => void doInvite()}>
                      Generate invite link
                    </button>
                    <span className="text-label text-secondary">Single-use · expires in 7 days</span>
                  </div>

                  {detail.invites.length > 0 && (
                    <ul className="mt-3 flex flex-col gap-2">
                      {detail.invites.map((i) => (
                        <li
                          key={i.token}
                          className="flex items-center justify-between gap-3 rounded-control border border-hairline bg-surface px-3 py-2.5"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Pill tone="neutral">{i.role}</Pill>
                            <span
                              className={`min-w-0 truncate font-mono text-label ${freshInvite === i.token ? 'text-display' : 'text-secondary'}`}
                            >
                              {inviteUrl(i.token)}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <CopyLink text={inviteUrl(i.token)} />
                            <button className={btnDanger} disabled={busy} onClick={() => void doRevoke(i.token)}>
                              Revoke
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {/* Danger zone: leave + delete. */}
              <div className="mt-6 flex items-center justify-between gap-3 border-t border-hairline pt-4">
                {!detail.personal ? (
                  <button className={btn} disabled={busy} onClick={() => void doLeave()}>
                    Leave team
                  </button>
                ) : (
                  <span className="text-label text-secondary">Your personal team can't be left or deleted.</span>
                )}
                {isOwner && !detail.personal && (
                  <button
                    className={btnDanger}
                    disabled={busy || detail.loopCount > 0}
                    title={
                      detail.loopCount > 0
                        ? `Move or delete this team's ${detail.loopCount} loop${detail.loopCount === 1 ? '' : 's'} first`
                        : undefined
                    }
                    onClick={() => void doDelete()}
                  >
                    Delete team
                    {detail.loopCount > 0 ? ` (${detail.loopCount} loop${detail.loopCount === 1 ? '' : 's'})` : ''}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
