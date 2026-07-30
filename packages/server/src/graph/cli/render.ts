/**
 * SELF-GUIDING OUTPUT - captain decision 15(b).
 *
 * "Every output prints the sensible next commands, and kernel refusals return the
 * allowed-transition list." That is not a nicety: an agent that has just been
 * refused has exactly two ways forward - be told what it may do, or guess - and
 * the second one is what "跑崩" looks like from the inside.
 *
 * So every rendered result carries three things: what happened, the facts, and
 * the one to three commands that make sense NOW. A refusal carries what happened,
 * why, and what is legal instead. Nothing else is printed, because a run reading
 * a wall of text is a run that skims it.
 *
 * Rendered in TOON (the axi convention the machine CLI already speaks -
 * `gateway/toon.ts` is the shared, pure serializer), so the `graph` binary is a
 * pure text sink: the server decides what a result looks like, one implementation,
 * and the CLI prints bytes. `--json` bypasses all of it with the structured half.
 */
import { detailBlock, doc, errorBlock, helpBlock, listBlock, scalar, type Scalar } from "../../gateway/toon.js";
import type { VerbFail, VerbOk } from "./verbs.js";

/** A successful verb result, as the run reads it. */
export function renderOk(verb: string, result: VerbOk): string {
  const rows: Array<[string, Scalar]> = [["result", result.summary]];
  if (result.replay) rows.push(["replay", true]);
  for (const [k, v] of Object.entries(result.data)) {
    if (k === "replay") continue;
    rows.push([k, renderable(v)]);
  }
  return doc(detailBlock(verb.replace(/\s+/g, " "), rows), result.next.length ? helpBlock(result.next) : "");
}

/**
 * A refusal, WITH THE WAY OUT.
 *
 * The `allowed` list is the load-bearing half. A kernel refusal like
 * "ILLEGAL_FROM_STATE: `fix` cannot run from `open`" is precise and unactionable;
 * the same refusal followed by `allowed[2]: start, cancel` is a run's next move.
 */
export function renderFail(verb: string, result: VerbFail): string {
  const sections = [errorBlock(result.message, result.code)];
  if (result.allowed?.length) {
    sections.push(listBlock("allowed", ["option"], result.allowed.map((a) => [a])));
  } else if (result.allowed) {
    // An EMPTY allowed list is a real answer and a different one from absence:
    // "there is nothing you may do here" (a gate waiting on a person) must not
    // read as "we did not check".
    sections.push("allowed: [] — nothing this run may do here; a person has to act");
  }
  if (result.data) {
    sections.push(detailBlock("context", Object.entries(result.data).map(([k, v]) => [k, renderable(v)])));
  }
  sections.push(helpBlock([`graph ${verb} --help`]));
  return doc(...sections);
}

/** The usage screen for one verb, or for the whole set this run may call. */
export function renderHelp(lines: string[]): string {
  return lines.join("\n");
}

/** Scalars pass through; anything structured is JSON so a nested value is still
 *  readable on one line rather than rendering as `[object Object]`. */
function renderable(v: unknown): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

/** Re-exported so the router can render its own top-level errors identically. */
export { errorBlock, helpBlock, scalar };
