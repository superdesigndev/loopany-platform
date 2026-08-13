import { createFileRoute } from '@tanstack/react-router'
import { auth } from '../auth'
import * as store from '../db/store'
import { mintMachineKey, sha256 } from '../gateway/tokens'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

export const Route = createFileRoute('/api/machines/$machineId')({ server: { handlers: {
  POST: async ({ request, params }: { request: Request; params: { machineId: string } }) => {
    const actor = (await auth.api.getSession({ headers: request.headers }))?.user
    if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const machine = await store.getMachine(params.machineId)
    if (!machine || machine.enrolledBy !== actor.id) return Response.json({ error: 'not found' }, { status: 404 })
    const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
    if (parsed.kind === 'too-large') return Response.json({ error: 'request body too large' }, { status: 413 })
    if (parsed.kind === 'invalid' || !parsed.body || typeof parsed.body !== 'object') return Response.json({ error: 'invalid request body' }, { status: 400 })
    const body = parsed.body as { action?: unknown; teamId?: unknown }
    if (body.action === 'enable-binding' || body.action === 'disable-binding') {
      if (typeof body.teamId !== 'string' || !body.teamId.trim()) return Response.json({ error: 'teamId is required' }, { status: 400 })
      const ok = await store.setTeamMachineBindingEnabled(body.teamId.trim(), machine.id, body.action === 'enable-binding', actor.id)
      return ok ? Response.json({ ok: true }) : Response.json({ error: 'not found' }, { status: 404 })
    }
    if (body.action === 'revoke') {
      await store.updateMachine(machine.id, { revokedAt: new Date().toISOString(), online: false })
      return Response.json({ ok: true })
    }
    if (body.action !== 'reclaim' && body.action !== 'rotate') return Response.json({ error: 'invalid action' }, { status: 400 })
    if (machine.revokedAt) return Response.json({ error: 'revoked machines require an explicit Web recovery action' }, { status: 409 })
    const key = mintMachineKey()
    await store.updateMachine(machine.id, { tokenHash: sha256(key), keyRotatedAt: new Date().toISOString(), online: false })
    if (typeof body.teamId === 'string' && body.teamId.trim() && await store.isTeamMember(body.teamId.trim(), actor.id)) {
      await store.bindMachineToTeam(body.teamId.trim(), machine.id, actor.id)
    }
    return Response.json({ id: machine.id, key }, { headers: { 'cache-control': 'no-store' } })
  },
} } })
