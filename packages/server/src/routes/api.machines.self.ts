import { createFileRoute } from '@tanstack/react-router'
import { machineCredential } from '../gateway/http'
import { authenticateMachineCredential } from '../gateway/machineAuth'

export const Route = createFileRoute('/api/machines/self')({ server: { handlers: {
  GET: async ({ request }: { request: Request }) => {
    const authenticated = await authenticateMachineCredential(machineCredential(request))
    if (authenticated.kind === 'invalid') return Response.json({ error: 'invalid_credential' }, { status: 401 })
    if (authenticated.kind === 'revoked') return Response.json({ error: 'machine_revoked' }, { status: 401 })
    const machine = authenticated.machine
    return Response.json({ id: machine.id, enrolledBy: machine.enrolledBy, name: machine.name, revoked: false }, { headers: { 'cache-control': 'no-store' } })
  },
} } })
