/**
 * Doc-split migration — REHEARSAL by default. Reads every loop row, runs the
 * three-plane splitter (fields / doc / events) over its task-file content, and
 * reports what WOULD change: per-row seeded-event counts, carried front-matter
 * keys, and a loss check (every content line must land in the doc or in an
 * event — nothing may silently vanish). It also flags rows that are NOT safe
 * to migrate yet (the drain gate):
 *   - content clipped at the ingress cap (the row is already lossy — migrate
 *     from the machine's real file, not this clip);
 *   - a sync stamp stale relative to a machine that looks present (bytes may
 *     be in flight — drain first).
 *
 * `--execute` runs the CONSERVATIVE migration: seed historical Timeline
 * entries as events (deduped like the live ingest), doc left byte-identical.
 * A destructive doc rewrite was deliberately dropped: the fields plane derives
 * from the doc's front matter, so stripping it would erase work-state, and a
 * doc-preserving seed is idempotent + race-free against a live watcher flush.
 *
 * Usage:  DATABASE_URL=… npx tsx scripts/migrate-v2-split.ts [--json | --execute]
 */
import { addEvent, listEvents, listLoops, listMachines } from "../src/db/store.js";
import { splitTaskDoc } from "../src/server/docSplit.js";
import { machinePresence } from "../src/lib/machinePresence.js";

/** Mirrors the gateway's wire-field clip budget (`gateway/http.ts` WIRE_TEXT_CAP). */
const INGRESS_CLIP = 512 * 1024;
/** A sync stamp older than this on a present machine suggests undrained bytes. */
const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

interface RowReport {
  loopId: string;
  slug: string | null;
  bytes: number;
  docBytes: number;
  seededEvents: number;
  carriedKeys: string[];
  lostLines: string[];
  flags: string[];
}

/** Loss detector: every non-blank line of the original must survive into ONE of
 *  the three planes — the doc, a seeded event's text, or the derived field index
 *  (a subtracted front-matter line, whose key the splitter reports as
 *  represented). Dates/actors move into event columns, so a dated line matches
 *  on its text remainder. */
function lostLines(original: string, doc: string, events: Array<{ text: string }>, representedKeys: string[]): string[] {
  const eventText = events.map((e) => e.text).join("\n");
  const represented = new Set(representedKeys);
  const lost: string[] = [];
  for (const line of original.split("\n")) {
    const t = line.trim();
    if (!t || t === "---" || /^#{1,6}\s+timeline\b/i.test(t)) continue; // structure, fully replaced
    // A subtracted front-matter line lives in the FIELDS plane.
    const fmKey = /^([A-Za-z0-9][A-Za-z0-9_.-]*):\s/.exec(t)?.[1];
    if (fmKey && represented.has(fmKey)) continue;
    // Match on the line's content tail (front-matter values, timeline text, prose).
    const tail = t.replace(/^[-*]\s+/, "").replace(/^(\*\*|\[)?\d{4}-\d{2}-\d{2}(\*\*|\])?\s*(\([^)]+\))?\s*[:—–-]?\s*/, "");
    const needle = tail || t;
    if (!doc.includes(needle) && !eventText.includes(needle)) lost.push(t.slice(0, 120));
  }
  return lost;
}

/**
 * Execute mode (CONSERVATIVE, idempotent): seed each row's historical dated
 * Timeline entries into the event stream, deduped on (day, text) exactly like
 * the live ingest path — the doc itself is left byte-identical (nothing to
 * retain, nothing to race: a concurrent watcher flush just re-runs the same
 * dedup). Re-running is a no-op. Undated/continuation-only rows seed nothing.
 */
async function executeSeed(): Promise<number> {
  const loops = await listLoops();
  let rows = 0;
  let seeded = 0;
  for (const loop of loops) {
    const { events } = splitTaskDoc(loop.taskFileContent ?? "");
    const dated = events.filter((e) => e.at);
    if (!dated.length) continue;
    rows++;
    const existing = await listEvents(loop.id, { limit: 200 });
    const seen = new Set(existing.map((e) => `${e.at?.slice(0, 10)}|${e.text ?? ""}`));
    for (const e of dated) {
      // Key on the CLIPPED text — the stored row is clipped, so an unclipped
      // key would re-seed every over-cap entry on re-run.
      const text = e.text.slice(0, 2000);
      const key = `${e.at!.slice(0, 10)}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await addEvent({
        loopId: loop.id,
        type: "note",
        actor: e.actor ?? "timeline",
        at: e.at,
        text,
        data: { source: "timeline" },
      });
      seeded++;
    }
  }
  console.log(`seeded ${seeded} events across ${rows} rows (re-run is a no-op)`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--execute")) return executeSeed();
  const json = process.argv.includes("--json");
  const machines = new Map((await listMachines()).map((m) => [m.id, m]));
  const loops = await listLoops();
  const reports: RowReport[] = [];
  for (const loop of loops) {
    const content = loop.taskFileContent ?? "";
    const r = splitTaskDoc(content);
    const flags: string[] = [];
    if (content.length >= INGRESS_CLIP) flags.push("at-ingress-clip");
    const m = machines.get(loop.machineId);
    if (m && loop.taskFileSyncedAt) {
      const presence = machinePresence(m.online, m.lastSeen);
      if (presence !== "offline" && Date.now() - Date.parse(loop.taskFileSyncedAt) > STALE_SYNC_MS) flags.push("stale-sync-on-present-machine");
    }
    reports.push({
      loopId: loop.id,
      slug: loop.taskMeta?.id ?? null,
      bytes: content.length,
      docBytes: r.doc.length,
      seededEvents: r.events.length,
      carriedKeys: r.carriedKeys,
      lostLines: lostLines(content, r.doc, r.events, r.representedKeys),
      flags,
    });
  }
  const losses = reports.filter((r) => r.lostLines.length);
  const flagged = reports.filter((r) => r.flags.length);
  if (json) {
    console.log(JSON.stringify({ rows: reports.length, losses: losses.length, flagged: flagged.length, reports }, null, 2));
  } else {
    for (const r of reports) {
      const notes = [
        `${r.seededEvents} events`,
        ...(r.carriedKeys.length ? [`carried: ${r.carriedKeys.join(",")}`] : []),
        ...(r.flags.length ? [`FLAGGED: ${r.flags.join(",")}`] : []),
        ...(r.lostLines.length ? [`LOSS: ${r.lostLines.length} lines`] : []),
      ];
      console.log(`${r.slug ?? r.loopId}  ${r.bytes}B → doc ${r.docBytes}B · ${notes.join(" · ")}`);
      for (const l of r.lostLines) console.log(`    lost: ${l}`);
    }
    console.log(`\nrows: ${reports.length} · losses: ${losses.length} · drain-gate flagged: ${flagged.length}`);
  }
  return losses.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
