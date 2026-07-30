/**
 * Graph Engineering v1 - SENSING, pipe 1: the GitHub READ transport.
 *
 * READ-ONLY BY CONSTRUCTION, at three layers, the same posture `pull-prod.ts`
 * takes toward the production database:
 *
 *   1. the only statement this module can issue is the GraphQL `query` built
 *      below - there is no mutation text in the file at all;
 *   2. it runs through `gh api graphql`, whose credentials are the operator's own
 *      `gh` login. Nothing here reads or writes a token;
 *   3. the child process is spawned with a fixed argv (`execFile`, never a
 *      shell), a hard timeout and a bounded output buffer, so a hung or chatty
 *      response cannot wedge or exhaust the server.
 *
 * ── batching, and why GraphQL ───────────────────────────────────────────────
 *
 * The brief's requirement is "batch by repo, respect rate limits". REST would be
 * one request per PR (20 mirrors ⇒ 20 requests, 20 rate-limit units). One
 * GraphQL query with an ALIASED field per PR fetches a whole repo's worth for a
 * cost of 1 - and the same call returns the live `rateLimit` block, so the sweep
 * knows its remaining budget from the response rather than from a guess. Requests
 * are chunked (`MAX_PRS_PER_QUERY`) because GraphQL bounds query complexity, and
 * repos run at a small fixed concurrency.
 *
 * ── the seam ────────────────────────────────────────────────────────────────
 *
 * `PrFetcher` is an interface and this is one implementation. Every probe injects
 * a fake instead, so the poller's dedup, replay and auto-close behaviour is tested
 * without a network - which is the only way "double-poll produces zero rows" can
 * be asserted deterministically.
 *
 * ── the zero-exec invariant ─────────────────────────────────────────────────
 *
 * The server runs no LLM and executes no USER code. `gh` is neither: it is an
 * operator-installed binary invoked with a fixed argument vector and no user
 * input on the command line (repo and PR numbers are validated against the
 * mirror identity regex before they get here). Nothing in the graph payloads can
 * reach argv. The alternative - a raw HTTPS call - would mean this server holding
 * a GitHub token, which is a bigger surface than a read-only subprocess.
 */
import { execFile } from "node:child_process";

import { logger } from "../../logger.js";
import { parsePrExternalId, referencedPrs, type ObservedPr, type PrChecks, type PrIdentity, type PrState } from "./pr.js";

/** PRs per GraphQL query. GitHub bounds query complexity; 25 aliased PR fields
 *  is comfortably inside it and keeps one repo to one or two calls. */
export const MAX_PRS_PER_QUERY = 25;

/** Repos fetched concurrently. Small on purpose: the sweep is a background
 *  freshness job, and a burst of parallel API calls buys nothing. */
export const REPO_CONCURRENCY = 3;

/** Hard timeout per `gh` call. */
export const FETCH_TIMEOUT_MS = 20_000;

/** Output cap per `gh` call (PR bodies are included, so this is generous). */
export const FETCH_MAX_BYTES = 8 * 1024 * 1024;

/** Below this remaining rate-limit budget the sweep stops early rather than
 *  spending the last of a shared quota on a background refresh. */
export const RATE_LIMIT_FLOOR = 100;

/**
 * How the poller reads the outside world. One call per repo-chunk; the result maps
 * PR number → facts, and a number the fetcher could not resolve is simply ABSENT
 * (a deleted PR, a repo we lost access to) rather than a fabricated `closed`.
 */
export interface PrFetcher {
  fetch(repo: string, numbers: number[]): Promise<FetchBatch>;
}

export interface FetchBatch {
  observed: Map<number, ObservedPr>;
  /** Remaining GraphQL rate-limit budget, when the transport reports one. */
  rateLimitRemaining?: number;
  /** Numbers the request asked for and did not get back, with why. Surfaced, never
   *  swallowed: a PR that stopped resolving is a fact about the world too. */
  missing: { number: number; why: string }[];
}

// ---- the GraphQL query ----

/**
 * One aliased `pullRequest` field per number. Aliases are `p<number>`, which is a
 * legal GraphQL name and trivially reversible; the numbers are integers validated
 * by the caller, so nothing user-shaped is interpolated into the query text.
 */
function buildQuery(repo: string, numbers: number[]): string {
  const [owner, name] = repo.split("/");
  const fields = numbers
    .map(
      (n) => `    p${n}: pullRequest(number: ${n}) {
      number
      state
      merged
      isDraft
      title
      body
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }`,
    )
    .join("\n");
  return `query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
${fields}
  }
  rateLimit { remaining cost }
}`;
}

interface GhPr {
  number?: number;
  state?: string;
  merged?: boolean;
  isDraft?: boolean;
  title?: string;
  body?: string | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
}

/** GitHub's `PullRequestState` → our closed set. `merged` is also carried as its
 *  own boolean, so a disagreement between the two is visible rather than folded. */
function toState(raw: string | undefined, merged: boolean | undefined): PrState {
  const v = (raw ?? "").toUpperCase();
  if (v === "MERGED" || merged === true) return "merged";
  if (v === "CLOSED") return "closed";
  return "open";
}

/**
 * GitHub's status-check rollup → our four answers. A PR with no rollup has no CI
 * on its head commit, which is `none`; an unrecognized rollup state is `pending`,
 * because "I do not know yet" is the honest reading of a state this build has not
 * seen and it never claims green.
 */
function toChecks(raw: string | undefined | null): PrChecks {
  switch ((raw ?? "").toUpperCase()) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "":
      return "none";
    default:
      return "pending";
  }
}

/** One GraphQL PR node → an `ObservedPr`, or undefined when the node is null
 *  (no such PR / no access) or carries no number to trust. */
export function toObserved(repo: string, node: GhPr | null | undefined): ObservedPr | undefined {
  if (!node || typeof node.number !== "number") return undefined;
  const identity: PrIdentity = { repo, number: node.number };
  const merged = node.merged === true;
  return {
    ...identity,
    state: toState(node.state, merged),
    merged,
    checks: toChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    title: (node.title ?? "").trim() || `PR #${node.number}`,
    draft: node.isDraft === true,
    // Cross-references come from prose the sweep already fetched - the cheap,
    // honest subset (see `referencedPrs`).
    references: referencedPrs(identity, `${node.title ?? ""}\n${node.body ?? ""}`),
  };
}

// ---- the transport ----

/** Injectable process seam, so a test can drive the parser without `gh`. */
export type GhRunner = (args: string[]) => Promise<string>;

const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.LOOPANY_GH_BIN?.trim() || "gh",
      args,
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: FETCH_MAX_BYTES, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          // `gh api graphql` prints partial-error responses to stdout AND exits
          // non-zero. Keep the body when there is one: a batch where one PR is
          // inaccessible still has good data for the rest.
          if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
          return reject(new Error(`${err.message}${stderr ? ` - ${String(stderr).trim().slice(0, 400)}` : ""}`));
        }
        resolve(stdout);
      },
    );
  });

/**
 * The real fetcher. `gh` is invoked once per chunk; a chunk that fails ENTIRELY
 * reports every number in it as missing rather than throwing, so one unreachable
 * repo cannot abort a sweep over the others.
 */
export function ghPrFetcher(runner: GhRunner = runGh): PrFetcher {
  return {
    async fetch(repo, numbers) {
      const observed = new Map<number, ObservedPr>();
      const missing: { number: number; why: string }[] = [];
      let rateLimitRemaining: number | undefined;

      for (const chunk of chunks(numbers, MAX_PRS_PER_QUERY)) {
        let body: unknown;
        try {
          body = JSON.parse(await runner(["api", "graphql", "-f", `query=${buildQuery(repo, chunk)}`]));
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          logger.warn({ repo, count: chunk.length, err: why }, "sensing: gh batch failed");
          for (const n of chunk) missing.push({ number: n, why });
          continue;
        }
        const data = (body as { data?: { repository?: Record<string, GhPr | null>; rateLimit?: { remaining?: number } } })
          .data;
        const errors = (body as { errors?: { message?: string }[] }).errors;
        if (typeof data?.rateLimit?.remaining === "number") rateLimitRemaining = data.rateLimit.remaining;
        for (const n of chunk) {
          const parsed = toObserved(repo, data?.repository?.[`p${n}`]);
          if (parsed) observed.set(n, parsed);
          else missing.push({ number: n, why: errors?.[0]?.message ?? "no pullRequest node in the response" });
        }
      }
      return { observed, rateLimitRemaining, missing };
    },
  };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Group mirror external ids into `repo → numbers` - the batch shape the fetcher
 *  takes. Anything that is not a pull-request external id is dropped, so the
 *  sweep can only act on rows it understands. */
export function groupByRepo(externalIds: (string | null)[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const raw of externalIds) {
    const id = parsePrExternalId(raw);
    if (!id) continue;
    const list = out.get(id.repo) ?? [];
    if (!list.includes(id.number)) list.push(id.number);
    out.set(id.repo, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

export const _internals = { buildQuery, toState, toChecks, chunks, runGh, REPO_CONCURRENCY };
