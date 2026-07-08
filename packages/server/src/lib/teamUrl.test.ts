import { describe, expect, it } from 'vitest'
import { ALL_TEAMS_PARAM, teamIdFromParam, teamParamFromId } from './teamUrl'

/**
 * The pure map between a team id (store/auth scope) and its `/t/<param>` URL form.
 * Both route loaders and the TeamSwitcher share it, so a round-trip must be lossless
 * and the admin aggregate must translate through the clean `all` segment.
 */
describe('teamUrl', () => {
  it('rides a real team id verbatim in both directions', () => {
    for (const id of ['team-abc', 'team-repro-B', 'team-shared', 'team-user_123']) {
      expect(teamParamFromId(id)).toBe(id)
      expect(teamIdFromParam(id)).toBe(id)
      expect(teamIdFromParam(teamParamFromId(id))).toBe(id)
    }
  })

  it('maps the __all__ aggregate sentinel to the clean `all` segment and back', () => {
    expect(teamParamFromId('__all__')).toBe(ALL_TEAMS_PARAM)
    expect(ALL_TEAMS_PARAM).toBe('all')
    expect(teamIdFromParam('all')).toBe('__all__')
    // Round-trip through the URL form.
    expect(teamIdFromParam(teamParamFromId('__all__'))).toBe('__all__')
  })
})
