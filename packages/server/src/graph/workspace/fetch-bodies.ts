/**
 * Graph v1 workspace demo - the READ-ONLY artifact-body fetch.
 *
 * The control-plane database holds an artifact's hash and its indexed front
 * matter, but never its BYTES: those are content-addressed in the artifact store
 * (Cloudflare R2). This module fetches them for the artifacts already mirrored
 * into the local workspace and caches them on disk, so the Library can show the
 * real document instead of a metadata-only notice.
 *
 * READ-ONLY BY CONSTRUCTION, the same posture as `pull-prod.ts`:
 *
 *   1. it issues exactly ONE S3 operation - `GetObject`. There is no
 *      PutObject/DeleteObject/CreateMultipartUpload import anywhere in the file,
 *      so a write is not reachable even by mistake;
 *   2. it deliberately does NOT reuse `gateway/blobstore.ts` `R2BlobStore`,
 *      which carries `put`/`delete` - a read-only job should not hold a handle
 *      that can write;
 *   3. it DOES import that module's `blobKey`, because the object layout must
 *      come from the server's own source of truth rather than a second copy.
 *
 * `bodies.test.ts` pins (1) and (3) by reading this file's source.
 *
 * Credentials come from an env file (default the R2 block the captain provided);
 * they are loaded into this process only and never written anywhere.
 */
import fs from "node:fs";
import path from "node:path";

import { blobKey } from "../../gateway/blobstore.js";
import { snapshotPath, type ProdFile } from "./pull-prod.js";

/** Bodies larger than this are left as metadata-only: a megabyte of transcript
 *  in a jsonb payload helps nobody, and the notice stays honest about why. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface R2Credentials {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * Resolve R2 credentials from the environment, else from an env file. Read into
 * memory only - never echoed, never copied to another path.
 */
export function resolveR2(readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): R2Credentials {
  const fromEnv = (k: string): string | undefined => process.env[k]?.trim() || undefined;
  let values: Record<string, string> = {};
  const file = process.env.LOOPANY_R2_ENV_FILE?.trim();
  if (file) {
    for (const line of readFile(file).split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) values[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
  const pick = (k: string) => fromEnv(k) ?? values[k];

  const bucket = pick("LOOPANY_R2_BUCKET");
  const accessKeyId = pick("LOOPANY_R2_ACCESS_KEY_ID");
  const secretAccessKey = pick("LOOPANY_R2_SECRET_ACCESS_KEY");
  const accountId = pick("LOOPANY_R2_ACCOUNT_ID");
  const endpoint = pick("LOOPANY_R2_ENDPOINT") ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error(
      "incomplete R2 credentials - set LOOPANY_R2_ENV_FILE to a file with " +
        "LOOPANY_R2_{ACCOUNT_ID,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}, or set those in the environment",
    );
  }
  return { bucket, endpoint, accessKeyId, secretAccessKey, region: pick("LOOPANY_R2_REGION") ?? "auto" };
}

/** Where fetched bytes are cached, beside the demo database. */
export function bodyCacheDir(): string {
  const dir = process.env.LOOPANY_DATA_DIR?.trim();
  if (!dir) throw new Error("LOOPANY_DATA_DIR is unset - run `pnpm graph:bodies` from the repo root");
  return path.join(dir, "blob-cache");
}

const cacheFile = (hash: string) => path.join(bodyCacheDir(), `${hash}.txt`);

/** A cached body, if this hash has already been fetched. */
export function readCachedBody(hash: string): string | undefined {
  try {
    return fs.readFileSync(cacheFile(hash), "utf8");
  } catch {
    return undefined;
  }
}

export interface FetchReport {
  requested: number;
  fetched: number;
  cached: number;
  /** Present in the manifest but absent from the store (GC'd, or never synced). */
  missing: number;
  /** Too large to inline, or not decodable as text. */
  skipped: { hash: string; path: string; why: string }[];
}

/**
 * Fetch bodies for every non-binary artifact in the snapshot, caching each under
 * its hash. Already-cached hashes are not re-fetched, so re-running is cheap and
 * works offline.
 */
export async function fetchArtifactBodies(options: { files?: ProdFile[]; concurrency?: number } = {}): Promise<FetchReport> {
  const files = options.files ?? (JSON.parse(fs.readFileSync(snapshotPath(), "utf8")) as { files: ProdFile[] }).files;
  const creds = resolveR2();
  fs.mkdirSync(bodyCacheDir(), { recursive: true });

  // ONE command, GetObject. Nothing that writes is imported.
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    forcePathStyle: true, // R2 requires path-style addressing
  });

  // One entry per distinct hash - artifact bytes are content-addressed, so two
  // loops holding the same file are one fetch.
  const wanted = new Map<string, ProdFile>();
  for (const f of files) if (!f.binary && !wanted.has(f.hash)) wanted.set(f.hash, f);

  const report: FetchReport = { requested: wanted.size, fetched: 0, cached: 0, missing: 0, skipped: [] };
  const queue = [...wanted.values()];
  const concurrency = options.concurrency ?? 8;

  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      if (readCachedBody(file.hash) !== undefined) {
        report.cached++;
        continue;
      }
      if (file.size > MAX_BODY_BYTES) {
        report.skipped.push({ hash: file.hash, path: file.path, why: `${file.size} bytes exceeds the ${MAX_BODY_BYTES}-byte inline cap` });
        continue;
      }
      let bytes: Buffer | null;
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: blobKey(file.hash) }));
        const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
        bytes = body?.transformToByteArray ? Buffer.from(await body.transformToByteArray()) : null;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
          report.missing++;
          continue;
        }
        throw err;
      }
      if (!bytes) {
        report.missing++;
        continue;
      }
      const text = bytes.toString("utf8");
      // Invalid UTF-8 decodes to U+FFFD, so the text no longer re-encodes to the
      // same byte length. Storing that as a "document" would be fiction.
      if (Buffer.from(text, "utf8").length !== bytes.length || text.includes("\u0000")) {
        report.skipped.push({ hash: file.hash, path: file.path, why: "not valid UTF-8 text" });
        continue;
      }
      fs.writeFileSync(cacheFile(file.hash), text);
      report.fetched++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) || 1 }, worker));
  client.destroy();
  return report;
}
