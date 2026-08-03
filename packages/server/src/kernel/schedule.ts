import { Cron } from "croner";

/** The scheduler cursor always points to the first occurrence strictly after
 * `after`. Passing the clock in keeps catch-up deterministic in tests. */
export function nextOccurrenceAfter(cron: string, timezone: string | null, after: Date | string): string {
  const probe = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
  try {
    const next = probe.nextRun(after);
    if (!next) throw new Error(`cron expression never fires again: ${cron}`);
    return next.toISOString();
  } finally {
    probe.stop();
  }
}
