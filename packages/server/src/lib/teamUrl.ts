/**
 * Pure map between the active-team id (as used by the store / auth scope) and its
 * form in a dashboard URL segment (`/t/<param>`). The single source both the route
 * loaders and the TeamSwitcher use, so the URL form can't drift.
 *
 * A real team id rides the URL verbatim. The admin "All teams" aggregate is the
 * `__all__` sentinel (auth.ALL_TEAMS) internally, but appears as the clean reserved
 * word `all` in the path (`/t/all`). `all` is safe as a reserved segment: personal
 * teams are `team-<userId>` and no team id is the bare word `all`.
 */
export const ALL_TEAMS_PARAM = 'all'
/** Mirrors auth.ALL_TEAMS; kept local so this stays a framework-free pure module. */
const ALL_TEAMS = '__all__'

/** Team id (or the `__all__` sentinel) → its `/t/<param>` URL segment. */
export function teamParamFromId(id: string): string {
  return id === ALL_TEAMS ? ALL_TEAMS_PARAM : id
}

/** A `/t/<param>` URL segment → the team id (or the `__all__` sentinel). */
export function teamIdFromParam(param: string): string {
  return param === ALL_TEAMS_PARAM ? ALL_TEAMS : param
}
