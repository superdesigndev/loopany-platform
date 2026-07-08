import { useNavigate } from '@tanstack/react-router'
import type { TeamsView } from '../types'
import { setActiveTeamCookie } from '../lib/teamCookie'

/**
 * Header team entry. Always visible when team data exists: a single-team user
 * sees a quiet pill naming the active team (so the workspace context is never
 * invisible); anyone who can reach more than one team gets the select.
 *
 * Switching NAVIGATES to `/t/<id>` (the explicit team URL — bookmarkable, and
 * each tab keeps its own team). The cookie is still written, now only as the
 * last-used default that the bare `/` redirect falls back to (no longer an
 * authorization key). The navigation (and the route's `key={teamId}` remount) is
 * what re-scopes the dashboard, so no refresh callback is needed.
 */
export function TeamSwitcher({ data }: { data?: TeamsView }) {
  const navigate = useNavigate()
  if (!data || data.teams.length === 0) return null

  const selectTeam = (id: string) => {
    // Persist the last-used default (the `/` redirect hint), then navigate to the
    // team's explicit dashboard URL — the loader re-scopes every list fn to it.
    setActiveTeamCookie(id)
    void navigate({ to: '/t/$teamId', params: { teamId: id } })
  }

  if (data.teams.length === 1)
    return (
      <span
        title="Active team"
        className="inline-flex items-center rounded-full bg-raised px-3 py-1 text-label font-medium text-secondary"
      >
        {data.teams[0]!.name}
      </span>
    )

  return (
    <select
      aria-label="Active team"
      value={data.activeTeamId}
      onChange={(e) => selectTeam(e.target.value)}
      className="lp-select cursor-pointer rounded-full bg-raised py-1 pl-3 text-label font-medium text-secondary outline-none transition-colors hover:text-display"
    >
      {data.teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  )
}
