/**
 * `pnpm graph:bodies` - fetch the REAL bytes for the artifacts in the snapshot.
 *
 * Read-only against the artifact store (see `fetch-bodies.ts` for the posture),
 * caching each body under its content hash beside the demo database. Safe to
 * re-run: an already-cached hash is not re-fetched, so a second run is offline
 * and instant.
 */
import { fetchArtifactBodies } from "./fetch-bodies.js";

async function main(): Promise<void> {
  process.stdout.write("fetching artifact bodies (read-only)…\n");
  const report = await fetchArtifactBodies();
  process.stdout.write(
    [
      `  distinct artifacts  ${report.requested}`,
      `  fetched             ${report.fetched}`,
      `  already cached      ${report.cached}`,
      `  absent from store   ${report.missing}`,
      `  skipped             ${report.skipped.length}`,
      "",
    ].join("\n"),
  );
  // Say WHICH ones and why, so a metadata-only row in the Library is always
  // explainable rather than mysterious.
  for (const s of report.skipped.slice(0, 10)) process.stdout.write(`    - ${s.path}: ${s.why}\n`);
  if (report.skipped.length > 10) process.stdout.write(`    … and ${report.skipped.length - 10} more\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  // Keep it to the message: an AWS SDK error object can carry request context.
  process.stderr.write(`artifact body fetch failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
