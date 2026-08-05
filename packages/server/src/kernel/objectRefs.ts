/**
 * THE ONE OBJECT-REFERENCE RESOLVER — how a `<ref>` in a task/doc URL becomes an
 * object id. The loop half of this rule lives in `loopRefs.ts`; this is its
 * sibling for the two AUTHORED kinds.
 *
 * THE RULE: **id first, then the creation key within the caller's team.**
 *
 * Why a key resolves at all. A doc's id is ORGANIC (`ids.ts`) — fresh randomness
 * at creation, never re-derivable — so a run that files a product this pass has
 * no way to address it next pass except the handle it chose itself: `key:` in
 * the artifact's front matter, which is exactly the per-team unique string
 * `objects_key_idx` already enforces. Without this the key was write-only: it
 * de-duplicated a re-create and then could not be read back, so "products are
 * kernel objects" bottomed out at "re-POST the whole file and read the response".
 *
 * Why id wins. An id is a primary key and a key is user-chosen text, so a key
 * that happens to look like an id must never shadow the real row. The id read is
 * a global primary-key lookup and is deliberately NOT team-scoped here: the
 * caller applies its own team/kind guard, which is what keeps the existing
 * NOT_FOUND / WRONG_KIND teaching (and the enumeration-safe merge of "no such
 * object" with "not yours") in ONE place instead of two.
 *
 * Why an unresolvable ref comes back VERBATIM rather than as a failure: the
 * caller's refusal then names what the person typed (`hk-cleanup-card was not
 * found`), not some normalized form of it.
 *
 * Mirrors are deliberately out of scope. A mirror's id AND key are both derived
 * from `(team, kind, coords)`, so re-attaching resolves to the same row with no
 * handle to remember — the problem this resolver exists for does not arise.
 */
import * as store from "../db/kernelStore.js";

/**
 * Resolve a task/doc reference to a concrete object id. One extra read only when
 * the ref is not an id, so the common path (an id straight off a list row) costs
 * exactly what it did before.
 */
export async function resolveObjectRef(ref: string, teamId: string): Promise<string> {
  if (!ref) return ref;
  if (await store.getObject(undefined, ref)) return ref;
  const byKey = await store.getObjectByKey(undefined, teamId, ref);
  return byKey?.id ?? ref;
}
