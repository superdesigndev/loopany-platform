import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { credentialHome } from "./connect.js";
import { cliVersion, versionBelow } from "./version.js";

export interface UserSession {
  kind: "loopany-user-session";
  schemaVersion: 1;
  server: string;
  accessToken: string;
  expiresAt: string;
  user: { id: string; email: string; name: string };
  teamId?: string;
}

export function sessionPath(env: Record<string, string | undefined>): string {
  return join(credentialHome(env), "user-session.json");
}

/** Best-effort local Machine identity used only to refine audit attribution. */
export function readLocalMachineId(env: Record<string, string | undefined>): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(credentialHome(env), "machine.json"), "utf8")) as { id?: unknown };
    return typeof value.id === "string" && value.id.startsWith("m-") ? value.id : undefined;
  } catch { return undefined; }
}

export function readUserSession(env: Record<string, string | undefined>): UserSession | null {
  try {
    const value = JSON.parse(readFileSync(sessionPath(env), "utf8")) as UserSession;
    if (value.kind !== "loopany-user-session" || value.schemaVersion !== 1 || !/^https?:\/\//.test(value.server) || !value.accessToken || !value.user?.id) return null;
    return value;
  } catch { return null; }
}

export function writeUserSession(env: Record<string, string | undefined>, value: UserSession): void {
  const home = credentialHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = sessionPath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function clearUserSession(env: Record<string, string | undefined>): boolean {
  const existed = readUserSession(env) !== null;
  rmSync(sessionPath(env), { force: true });
  return existed;
}

export function selectTeam(env: Record<string, string | undefined>, teamId: string): UserSession {
  const session = readUserSession(env);
  if (!session) throw new Error("not logged in");
  const next = { ...session, teamId };
  writeUserSession(env, next);
  return next;
}

export type SessionTeam = { id: string; name: string; slug: string; path: string };
export type TeamDirectory = {
  team: SessionTeam;
  people: Array<{ id: string; email: string; role: string }>;
  machines: Array<{ id: string; name: string; alias: string | null; online: boolean; lastSeen: string | null; agentProfiles: string[] | null }>;
  agents: Array<{ address: string; machineId: string; machine: string; profile: string; availability: "available" | "offline" | "last-known"; lastSucceededAt: string | null }>;
};

export function fetchTeams(session: UserSession): SessionTeam[] {
  const script = `fetch(process.env.U,{headers:{authorization:'Bearer '+process.env.T}}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))}).catch(e=>{process.stderr.write(String(e));process.exit(2)})`;
  const out = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, U: `${session.server}/api/kernel/teams`, T: session.accessToken }, timeout: 30_000 });
  if (out.status !== 0) throw new Error("cannot reach the Loopany server");
  const value = JSON.parse(out.stdout) as { status: number; body: { teams?: SessionTeam[]; minCliVersion?: string } };
  if (value.body.minCliVersion && versionBelow(cliVersion(), value.body.minCliVersion)) throw new Error(`lk ${cliVersion()} is too old; this server requires lk ${value.body.minCliVersion} or newer`);
  if (value.status !== 200 || !value.body.teams) throw new Error("session expired; run lk login");
  return value.body.teams;
}

export function fetchTeamDirectory(session: UserSession, teamId: string): TeamDirectory {
  const script = `fetch(process.env.U,{headers:{authorization:'Bearer '+process.env.T}}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))}).catch(e=>{process.stderr.write(String(e));process.exit(2)})`;
  const url = `${session.server}/api/kernel/teams?teamId=${encodeURIComponent(teamId)}`;
  const out = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, U: url, T: session.accessToken }, timeout: 30_000 });
  if (out.status !== 0) throw new Error("cannot reach the Loopany server");
  const value = JSON.parse(out.stdout) as { status: number; body: TeamDirectory & { error?: string } };
  if (value.status !== 200 || !value.body.team) throw new Error(value.body.error || "could not load Team directory");
  return value.body;
}

export function bindMachineToWorkspace(session: UserSession, slug: string, machineId: string): { team: SessionTeam; machine: { id: string; alias?: string } } {
  const script = `fetch(process.env.U,{method:'POST',headers:{authorization:'Bearer '+process.env.T,'content-type':'application/json'},body:JSON.stringify({slug:process.env.S,machineId:process.env.M})}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))}).catch(e=>{process.stderr.write(String(e));process.exit(2)})`;
  const out = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, U: `${session.server}/api/kernel/teams`, T: session.accessToken, S: slug, M: machineId }, timeout: 30_000 });
  if (out.status !== 0) throw new Error("cannot reach the Loopany server");
  const value = JSON.parse(out.stdout) as { status: number; body: { team?: SessionTeam; machine?: { id: string; alias?: string }; error?: string } };
  if (value.status !== 200 || !value.body.team || !value.body.machine) throw new Error(value.body.error || "workspace setup failed");
  return { team: value.body.team, machine: value.body.machine };
}

export function revokeUserSession(
  session: UserSession,
  run: typeof spawnSync = spawnSync,
): void {
  const script = `fetch(process.env.U,{method:'POST',headers:{authorization:'Bearer '+process.env.T,origin:process.env.O,'content-type':'application/json'},body:'{}'}).then(r=>{if(!r.ok)process.exit(3)}).catch(()=>process.exit(2))`;
  const out = run(process.execPath, ["-e", script], {
    env: { ...process.env, U: `${session.server}/api/auth/sign-out`, T: session.accessToken, O: new URL(session.server).origin },
    timeout: 30_000,
  });
  if (out.status !== 0) throw new Error("could not revoke the CLI session; local credentials were kept");
}

/** Runs the RFC 8628 poller in a child so its verification URL is visible live
 * while the synchronous CLI architecture remains unchanged. */
export function deviceLogin(server: string, env: Record<string, string | undefined>): UserSession {
  const script = String.raw`
    const server = process.env.LK_LOGIN_SERVER, out = process.env.LK_LOGIN_FILE;
    const post = async (path, body) => { const r = await fetch(server + path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return {r,j:await r.json()}; };
    const start = await post('/api/auth/device/code',{client_id:'loopany-cli',scope:'openid profile email'});
    if (!start.r.ok) throw new Error(start.j.error_description || 'device login start failed');
    process.stdout.write('Open ' + start.j.verification_uri_complete + '\nCode: ' + start.j.user_code + '\nWaiting for approval...\n');
    let interval = start.j.interval || 5;
    for (;;) {
      await new Promise(r => setTimeout(r, interval * 1000));
      const token = await post('/api/auth/device/token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:start.j.device_code,client_id:'loopany-cli'});
      if (!token.r.ok) { if (token.j.error === 'authorization_pending') continue; if (token.j.error === 'slow_down') { interval += 5; continue; } throw new Error(token.j.error_description || token.j.error); }
      const me = await fetch(server + '/api/auth/get-session',{headers:{authorization:'Bearer ' + token.j.access_token}}); const session = await me.json();
      if (!me.ok || !session.user) throw new Error('could not resolve CLI identity');
      const value={kind:'loopany-user-session',schemaVersion:1,server,accessToken:token.j.access_token,expiresAt:new Date(Date.now()+token.j.expires_in*1000).toISOString(),user:{id:session.user.id,email:session.user.email,name:session.user.name}};
      const fs=await import('node:fs'); fs.writeFileSync(out+'.tmp',JSON.stringify(value,null,2),{mode:0o600}); fs.renameSync(out+'.tmp',out); break;
    }`;
  mkdirSync(credentialHome(env), { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, ["-e", script], { stdio: "inherit", env: { ...process.env, LK_LOGIN_SERVER: server.replace(/\/+$/, ""), LK_LOGIN_FILE: sessionPath(env) }, timeout: 35 * 60_000 });
  if (result.status !== 0) throw new Error("device login failed");
  const session = readUserSession(env);
  if (!session) throw new Error("device login completed without a valid session");
  return session;
}
