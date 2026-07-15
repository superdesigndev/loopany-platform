import { createAuthClient } from 'better-auth/react'

/** Browser auth client (same-origin /api/auth). */
export const authClient = createAuthClient()

export const { signIn, useSession } = authClient
