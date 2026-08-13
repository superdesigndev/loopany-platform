import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/auth-mode')({ server: { handlers: {
  GET: async () => {
    const shared = process.env.LOOPANY_AUTH_MODE?.trim() === 'shared-password'
    const github = !!(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim())
    return Response.json({ mode: shared ? 'shared-password' : github ? 'github' : 'open' })
  },
} } })
