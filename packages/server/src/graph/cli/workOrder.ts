/**
 * THE WORK-ORDER COMPOSER - where a run's instructions come from.
 *
 * Captain decision 15(5) is explicit: workflow instructions are DATA. What a
 * discovery run of THIS loop should do, in what order, reaching for which command
 * - that is a property of the loop, not of the platform, so it lives in the
 * object's own `workflow` field and is composed into the work order here. There
 * is no TypeScript string per loop and no per-domain branch anywhere in this
 * module, which is also exactly what decision 17 requires: a Reddit loop and a
 * code loop differ by the prose in a field.
 *
 * Three layers, in this order, and each is here for a different reason:
 *
 *   1. THE CORE (from the spec's declared `intent`). The non-negotiable part -
 *      identity, the reality check, the boundary, the reporting contract. It is
 *      declared once in the type spec because it must be true of every run of
 *      every loop, in every domain.
 *   2. THE WORKFLOW (from `object.workflow`). What THIS loop's run does. Prose,
 *      because the executor is an agent and because the moment this becomes a
 *      structured plan the platform is back in the business of sequencing.
 *   3. THE VERBS (from the ROLE). One to three commands with a line each -
 *      decision 15(a). A run never sees seven.
 *
 * PURE: no db, no clock, no I/O. `dispatchRun` calls it with the object it
 * already loaded.
 */
import { verbSection } from "./roles.js";

/** Fields the composer reads off the dispatching object. Everything is optional:
 *  a loop with no workflow and no role gets exactly the work order it got before
 *  this existed, which is what keeps the change additive. */
export interface WorkOrderInstance {
  role?: unknown;
  workflow?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Compose the intent an agent receives.
 *
 * The CORE always leads: an instruction whose first paragraph is instance prose
 * is one where a loop can talk its own run out of the disciplines. Then the
 * loop's workflow, then the commands.
 *
 * A loop with no `workflow` gets the core plus its verbs - which is a legitimate
 * posture (the brief in `context.object.brief` may be the whole story) and NOT a
 * reason to invent instructions on its behalf.
 */
export function composeWorkOrderIntent(coreIntent: string, instance: WorkOrderInstance): string {
  const workflow = str(instance.workflow);
  const role = str(instance.role);
  const sections: string[] = [coreIntent.trim()];

  if (workflow) {
    sections.push(
      ["# How this loop works", "", "This is the standing workflow for this loop. Follow it.", "", workflow].join("\n"),
    );
  }
  const verbs = verbSection(role);
  if (verbs.length) sections.push(verbs.join("\n").trim());

  return sections.join("\n\n");
}

/** Does this instance change the work order at all? Used by the handler to keep
 *  the untouched path byte-identical rather than re-composing an unchanged
 *  string. */
export function hasWorkOrderInstance(instance: WorkOrderInstance): boolean {
  return Boolean(str(instance.workflow) || str(instance.role));
}
