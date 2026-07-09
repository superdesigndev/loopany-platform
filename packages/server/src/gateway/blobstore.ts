/**
 * Content-addressed blob byte store for live-synced loop artifacts.
 *
 * Bytes are keyed by their sha256 hash (content-addressed ⇒ deduped across every
 * loop/run). The store ONLY writes/reads bytes — it never executes or interprets
 * them — preserving the server's zero-exec invariant.
 *
 * Two implementations behind one small interface:
 *   • R2BlobStore   — Cloudflare R2 (S3-compatible) for prod; creds via env.
 *   • MemoryBlobStore — in-process map for dev/tests (no network, no creds).
 *
 * The S3 client is dynamic-imported inside R2BlobStore so tests (and any deploy
 * without R2 creds) never load the AWS SDK, and it stays out of the client bundle.
 */
import { r2Config, type R2Config } from "../env.js";
import { logger } from "../logger.js";

const log = logger.child({ mod: "blobstore" });

export interface BlobStore {
  /** Does the store already hold bytes for this hash? (drives needHashes dedupe). */
  has(hash: string): Promise<boolean>;
  /** Persist bytes under the hash (caller has already verified sha256(bytes)===hash). */
  put(hash: string, bytes: Buffer): Promise<void>;
  /** Fetch bytes for a hash, or null when absent. */
  get(hash: string): Promise<Buffer | null>;
  /** Reclaim a blob's bytes (GC). Idempotent — deleting an absent hash is a no-op. */
  delete(hash: string): Promise<void>;
}

/** In-memory blob store — dev/test default (no network, no credentials). */
export class MemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Buffer>();
  async has(hash: string): Promise<boolean> {
    return this.map.has(hash);
  }
  async put(hash: string, bytes: Buffer): Promise<void> {
    this.map.set(hash, Buffer.from(bytes));
  }
  async get(hash: string): Promise<Buffer | null> {
    return this.map.get(hash) ?? null;
  }
  async delete(hash: string): Promise<void> {
    this.map.delete(hash);
  }
}

/** Object key for a blob hash. Flat namespace under a prefix — hashes are unique. */
function blobKey(hash: string): string {
  return `blobs/${hash}`;
}

/** Cloudflare R2 blob store over the S3-compatible API (AWS SDK v3). */
export class R2BlobStore implements BlobStore {
  // Lazily-constructed S3 client (dynamic import keeps the SDK out of tests/bundle).
  private client: unknown;
  constructor(private readonly cfg: R2Config) {}

  private async s3(): Promise<any> {
    if (this.client) return this.client;
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.client = new S3Client({
      region: this.cfg.region,
      endpoint: this.cfg.endpoint,
      credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
      // R2 requires path-style addressing.
      forcePathStyle: true,
    });
    return this.client;
  }

  async has(hash: string): Promise<boolean> {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: blobKey(hash) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async put(hash: string, bytes: Buffer): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    await client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: blobKey(hash), Body: bytes, ContentLength: bytes.length }),
    );
  }

  async get(hash: string): Promise<Buffer | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: blobKey(hash) }));
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) return null;
      return Buffer.from(await body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(hash: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    // S3/R2 DELETE is idempotent — deleting an absent key succeeds — so no
    // not-found special-casing is needed here.
    await client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: blobKey(hash) }));
  }
}

/** S3 "object absent" maps to a 404 / NoSuchKey / NotFound error shape. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * The configured blob store: R2 when creds are present, else an in-memory store
 * (dev/test). Constructed once and reused — the gateway accepts an injected store
 * for tests, so this factory's default only runs in real boots.
 */
export function createBlobStore(): BlobStore {
  const cfg = r2Config();
  if (cfg) {
    log.info({ bucket: cfg.bucket, endpoint: cfg.endpoint }, "blob store: Cloudflare R2");
    return new R2BlobStore(cfg);
  }
  log.warn("blob store: in-memory (no R2 credentials configured — set ADSCAILE_R2_* for durable storage)");
  return new MemoryBlobStore();
}
