/** The single writer of the `adscaile.team` active-team cookie. Both switch
 *  surfaces (the header TeamSwitcher and the cross-team loop banner) call this so
 *  they can't drift on cookie name/encoding/max-age/samesite. Client-set is fine:
 *  the server never trusts it blind (requestScope re-checks membership/admin). */
export function setActiveTeamCookie(id: string) {
  document.cookie = `adscaile.team=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`
}
