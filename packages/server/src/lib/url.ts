/**
 * `decodeURIComponent` that returns null on malformed percent-encoding instead
 * of throwing a URIError (which would escape a route handler as a 500). Shared
 * by the routes that decode path segments; the policy is uniform — ANY
 * malformed segment is the caller's clean 400, never silently kept raw.
 */
export function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}
