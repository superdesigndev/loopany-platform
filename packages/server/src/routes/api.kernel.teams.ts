import { createFileRoute } from '@tanstack/react-router'
import { auth } from '../auth'
import * as store from '../db/store'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'
import { readSnapshot } from '../kernel/store'
import { agentDirectory } from '../kernel/agentDirectory'

export const Route = createFileRoute('/api/kernel/teams')({ server: { handlers: {
  GET: async ({ request }: { request: Request }) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const teams = await store.listTeamsForUser(session.user.id)
    const requestedTeamId = new URL(request.url).searchParams.get('teamId')
    if (requestedTeamId) {
      const team = teams.find((item) => item.id === requestedTeamId)
      if (!team) return Response.json({ error: 'workspace not found' }, { status: 404 })
      const [members, machines, aliases, snapshot] = await Promise.all([
        store.listTeamMembers(team.id), store.listMachinesForTeam(team.id), store.listTeamAliases(team.id), readSnapshot(team.id),
      ])
      const visible = machines.filter((machine) => !machine.revokedAt)
      return Response.json({
        team: { id: team.id, name: team.name, slug: team.slug, path: `/${team.slug}` },
        people: members.flatMap((member) => member.email ? [{ id: member.userId, email: member.email, role: member.role }] : []),
        machines: visible.map((machine) => ({
          id: machine.id, name: machine.name, online: machine.online, lastSeen: machine.lastSeen,
          alias: aliases.find((item) => item.machineId === machine.id)?.alias ?? null,
          agentProfiles: machine.agentProfiles,
        })),
        agents: agentDirectory(visible, aliases, snapshot.runs),
      })
    }
    return Response.json({ minCliVersion: process.env.LOOPANY_MIN_CLI_VERSION ?? '0.1.0', teams: teams.map(({ id, name, slug }) => ({ id, name, slug, path: `/${slug}` })) })
  },
  POST: async ({ request }: { request: Request }) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
    if (parsed.kind === 'too-large') return Response.json({ error: 'request body too large' }, { status: 413 })
    const body = parsed.kind === 'ok' ? parsed.body as { slug?: unknown; machineId?: unknown } : null
    if (!body || typeof body.slug !== 'string' || typeof body.machineId !== 'string') return Response.json({ error: 'slug and machineId are required' }, { status: 400 })
    const team = await store.getTeamBySlug(body.slug)
    if (!team || !(await store.isTeamMember(team.id, session.user.id))) return Response.json({ error: 'workspace not found' }, { status: 404 })
    const machine = await store.getMachine(body.machineId)
    if (!machine || machine.enrolledBy !== session.user.id || machine.revokedAt) return Response.json({ error: 'machine not found' }, { status: 404 })
    await store.bindMachineToTeam(team.id, machine.id, session.user.id)
    const binding = (await store.listMachineBindings(machine.id)).find((row) => row.teamId === team.id)
    return Response.json({ team: { id: team.id, name: team.name, slug: team.slug, path: `/${team.slug}` }, machine: { id: machine.id, alias: binding?.alias } })
  },
} } })
