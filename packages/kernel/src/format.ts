/**
 * Cron display humanizer — THE one implementation (moved down from
 * packages/server/src/lib/format.ts, which now re-exports it). The server web
 * UI (lane label / loop card / form) and the kernel CLI's list surface all
 * read this, so "0 7 * * *" renders identically everywhere.
 */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Humanize common crontab patterns ("m h dom mon dow") into a readable phrase —
 * "every 3h", "every 15m", "hourly :07", "daily 07:00", "Mon 09:00". Anything
 * outside these common shapes falls back to the raw expression (shown verbatim,
 * with the literal cron always available at the detail surface).
 */
export function cronText(cron: string): string {
  const p = (cron || "").trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = p as [string, string, string, string, string];
  const dateWild = dom === "*" && mon === "*";
  const everyH = ho.match(/^\*\/(\d+)$/);
  if (everyH && dateWild && dow === "*") return `every ${everyH[1]}h`;
  const everyM = mi.match(/^\*\/(\d+)$/);
  if (everyM && ho === "*" && dateWild && dow === "*") return `every ${everyM[1]}m`;
  if (ho === "*" && /^\d+$/.test(mi) && dateWild && dow === "*") return `hourly :${mi.padStart(2, "0")}`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dateWild) {
    const hhmm = `${ho.padStart(2, "0")}:${mi.padStart(2, "0")}`;
    if (dow === "*") return `daily ${hhmm}`;
    // cron allows 7 for Sunday as well as 0.
    if (/^[0-7]$/.test(dow)) return `${DOW[Number(dow) % 7]} ${hhmm}`;
    const set = dowSet(dow);
    if (set) return `${set} ${hhmm}`;
  }
  return cron;
}

/** Comma-listed day-of-week set → a name ("weekdays", "weekends", "Mon/Thu").
 *  Null when the field isn't a plain comma list (ranges/steps stay raw cron). */
function dowSet(dow: string): string | null {
  const parts = dow.split(",");
  if (parts.length < 2 || !parts.every((p) => /^[0-7]$/.test(p))) return null;
  // 7 and 0 are both Sunday, so normalize before deduping ("0,7" is one day).
  const days = [...new Set(parts.map((p) => Number(p) % 7))].sort((a, b) => a - b);
  if (days.length === 7) return "daily";
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) return "weekdays";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "weekends";
  return days.map((d) => DOW[d]).join("/");
}
