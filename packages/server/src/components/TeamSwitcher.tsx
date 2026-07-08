import { useNavigate } from '@tanstack/react-router'
import type { TeamsView } from '../types'
import { setActiveTeamCookie } from '../lib/teamCookie'
import { teamParamFromId } from '../lib/teamUrl'

/** Sentinel matching auth.ALL_TEAMS — the admin "All teams" aggregate view. */
const ALL_TEAMS = '__all__'

/**
 * Header team entry. Always visible when team data exists: a single-team user
 * sees a quiet pill naming the active team (so the workspace context is never
 * invisible); anyone who can reach more than one team (or an admin, who also
 * gets the "All teams" aggregate) gets the select.
 *
 * Switching NAVIGATES to `/t/<id>` (the explicit team URL — bookmarkable, and
 * each tab keeps its own team). The cookie is still written, now only as the
 * last-used default that the bare `/` redirect falls back to (no longer an
 * authorization key). `onSwitch` is retained for the caller's own refresh needs
 * but the navigation is what re-scopes the dashboard.
 */
export function TeamSwitcher({ data, onSwitch: _onSwitch }: { data?: TeamsView; onSwitch: () => void }) {
  const navigate = useNavigate()
  if (!data || data.teams.length === 0) return null

  const selectTeam = (id: string) => {
    // Persist the last-used default (the `/` redirect hint), then navigate to the
    // team's explicit dashboard URL — the loader re-scopes every list fn to it.
    setActiveTeamCookie(id)
    void navigate({ to: '/t/$teamId', params: { teamId: teamParamFromId(id) } })
  }

  if (data.teams.length === 1 && !data.isAdmin)
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
      {data.isAdmin && <option value={ALL_TEAMS}>All teams</option>}
      {data.teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  )
}
