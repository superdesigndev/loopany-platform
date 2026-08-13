import { createAuthClient } from 'better-auth/react'
import { deviceAuthorizationClient } from 'better-auth/client/plugins'

/** Browser auth client (same-origin /api/auth). */
export const authClient = createAuthClient({ plugins: [deviceAuthorizationClient()] })

export const { signIn, useSession } = authClient
