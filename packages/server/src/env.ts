import os from "node:os";
import path from "node:path";

/**
 * LoopAny server data directory — holds the SQLite database (and any other
 * server-side state). On Fly this is the mounted volume; locally it defaults to
 * `~/.loopany`. Override with `LOOPANY_DATA_DIR`.
 */
export function dataDir(): string {
  return process.env.LOOPANY_DATA_DIR?.trim() || path.join(os.homedir(), ".loopany");
}

/** Absolute path to the SQLite database file. */
export function dbPath(): string {
  return process.env.LOOPANY_DB_PATH?.trim() || path.join(dataDir(), "loopany.db");
}

/**
 * Cloudflare R2 (S3-compatible) credentials for the artifact blob store. Read
 * from env so credentials are never hardcoded; absent ⇒ the blob store falls
 * back to an in-memory implementation (dev/test — no network, no creds). The
 * endpoint defaults to R2's account-scoped host when only the account id is set.
 */
export interface R2Config {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores region but the S3 client requires one; "auto" is R2's convention. */
  region: string;
}

export function r2Config(): R2Config | null {
  const accountId = process.env.LOOPANY_R2_ACCOUNT_ID?.trim();
  const bucket = process.env.LOOPANY_R2_BUCKET?.trim();
  const accessKeyId = process.env.LOOPANY_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.LOOPANY_R2_SECRET_ACCESS_KEY?.trim();
  const endpoint =
    process.env.LOOPANY_R2_ENDPOINT?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  return { bucket, endpoint, accessKeyId, secretAccessKey, region: process.env.LOOPANY_R2_REGION?.trim() || "auto" };
}
