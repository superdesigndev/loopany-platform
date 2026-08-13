import { createFileRoute } from '@tanstack/react-router'
import { randomUUID } from 'node:crypto'
import { auth } from '../auth'
import * as store from '../db/store'
import { mintMachineKey, sha256 } from '../gateway/tokens'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'

async function user(request: Request) { return (await auth.api.getSession({ headers: request.headers }))?.user }

export const Route = createFileRoute('/api/machines')({ server: { handlers: {
  GET: async ({ request }: { request: Request }) => {
    const actor = await user(request)
    if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const machines = (await store.listMachines()).filter(machine => machine.enrolledBy === actor.id && !machine.revokedAt)
    const teams = await store.listTeamsForUser(actor.id)
    return Response.json({ personalTeamId: store.teamIdForUser(actor.id), teams: teams.map(({ id, name, slug }) => ({ id, name, slug, path: `/${slug}` })), machines: await Promise.all(machines.map(async machine => ({ id: machine.id, name: machine.name, hostname: machine.hostname, platform: machine.platform, lastSeen: machine.lastSeen, online: machine.online, agentProfiles: machine.agentProfiles, bindings: (await store.listMachineBindings(machine.id)).map(binding => ({ teamId: binding.teamId, alias: binding.alias, enabled: binding.enabled })) }))) })
  },
  POST: async ({ request }: { request: Request }) => {
    const actor = await user(request)
    if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
    if (parsed.kind === 'too-large') return Response.json({ error: 'request body too large' }, { status: 413 })
    if (parsed.kind === 'invalid' || !parsed.body || typeof parsed.body !== 'object') return Response.json({ error: 'invalid request body' }, { status: 400 })
    const body = parsed.body as { name?: unknown; hostname?: unknown; platform?: unknown; arch?: unknown; alias?: unknown; teamId?: unknown }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'Loopany machine'
    const id = `m-${randomUUID()}`
    const key = mintMachineKey()
    const teamId = store.teamIdForUser(actor.id)
    await store.ensureTeam(teamId, `${actor.name}'s team`, actor.id)
    const text = (value: unknown, cap: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, cap) : null
    let alias = text(body.alias, 80)
    if (alias && await store.aliasTakenInTeam(teamId, alias, id)) alias = `${alias}-${id.slice(2, 8)}`
    await store.createMachine({ id, enrolledBy: actor.id, teamId, name, hostname: text(body.hostname, 255), platform: text(body.platform, 80), arch: text(body.arch, 80), alias, tokenHash: sha256(key), online: false })
    const selectedTeam = text(body.teamId, 160)
    if (selectedTeam && selectedTeam !== teamId && await store.isTeamMember(selectedTeam, actor.id)) await store.bindMachineToTeam(selectedTeam, id, actor.id)
    return Response.json({ id, key }, { status: 201, headers: { 'cache-control': 'no-store' } })
  },
} } })
