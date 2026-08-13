import { timingSafeEqual } from "node:crypto";
import * as store from "../db/store.js";
import { credentialSecret, machineIdFromToken, sha256 } from "./tokens.js";

export async function authenticateMachineCredential(credential: string) {
  const machineId = machineIdFromToken(credential);
  const machine = await store.getMachine(machineId);
  if (!machine) return { kind: "invalid" as const };
  const actual = Buffer.from(sha256(credentialSecret(credential)));
  const expected = Buffer.from(machine.tokenHash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { kind: "invalid" as const };
  if (machine.revokedAt) return { kind: "revoked" as const, machine };
  return { kind: "ok" as const, machine };
}

export async function machineCanAccessTeam(machine: { id: string; enrolledBy: string | null; teamId: string | null }, teamId: string): Promise<boolean> {
  return store.isMachineBoundToTeam(teamId, machine.id);
}
