/**
 * Superadmin predicate — extracted as a STANDALONE pure module (env-only, no
 * Better Auth import) so the framework-agnostic gateway can re-check admin
 * authorization at loop-create time without pulling in `auth.ts` (which
 * initializes Better Auth at module load). `auth.ts` re-exports `isSuperAdmin`
 * from here so there is one source of truth.
 *
 * Driven entirely by LOOPANY_SUPERADMINS (comma-separated emails, lowercased).
 * Empty ⇒ no superadmins.
 */
const superAdmins = new Set(
  (process.env.LOOPANY_SUPERADMINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function isSuperAdmin(email: string | null | undefined): boolean {
  return !!email && superAdmins.has(email.toLowerCase());
}
