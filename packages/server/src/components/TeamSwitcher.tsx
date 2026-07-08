import type { TeamsView } from '../types'
import { setActiveTeamCookie } from '../lib/teamCookie'

/** Sentinel matching auth.ALL_TEAMS — the admin "All teams" aggregate view. */
const ALL_TEAMS = '__all__'

/** Persist the active-team choice (the shared cookie writer), then refresh the
 *  host page's data. The server validates the cookie in requestScope, so a
 *  client-set is fine (membership/admin is re-checked each request). */
function selectTeam(id: string, refresh: () => void) {
  setActiveTeamCookie(id)
  refresh()
}

/**
 * Header team entry. Always visible when team data exists: a single-team user
 * sees a quiet pill naming the active team (so the workspace context is never
 * invisible); anyone who can reach more than one team (or an admin, who also
 * gets the "All teams" aggregate) gets the select.
 *
 * `onSwitch` is the host page's own refetch — NOT router.invalidate: the
 * dashboard renders from its fetch-then-set poll state (seeded once from the
 * loader), so a loader re-run alone would leave the visible data stale.
 */
export function TeamSwitcher({ data, onSwitch }: { data?: TeamsView; onSwitch: () => void }) {
  if (!data || data.teams.length === 0) return null

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
      onChange={(e) => selectTeam(e.target.value, onSwitch)}
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
