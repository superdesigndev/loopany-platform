/**
 * The GitHub WRITE transport - the one module in this repository that changes
 * something outside Loopany.
 *
 * It runs `gh` with the operator's own login. Deliberately not a raw HTTPS client
 * with a token: `gh` is already authenticated on the machine where this agent
 * runs, so the agent never reads, stores or forwards a credential, and the blast
 * radius of a bug here is bounded by what that login can already do.
 *
 * ── the shape of every call ─────────────────────────────────────────────────
 *
 * `execFile` with a FIXED argv - never a shell, so nothing in a directive payload
 * can become a command. `--body-file` (via stdin) rather than `--body`, so a
 * comment body is bytes on a pipe and not an argument vector - a comment
 * containing a quote, a newline or a `$(…)` is just text. A hard timeout and a
 * bounded buffer, so a hung call cannot wedge the poll loop.
 *
 * ── the seam ────────────────────────────────────────────────────────────────
 *
 * `Gh` is an interface and this is one implementation. Every probe injects a fake,
 * which is what lets "posting twice produces one comment" and "a default-branch
 * merge is refused" be asserted without touching a real repository - and lets the
 * whole agent be tested on a machine with no `gh` at all.
 */
import { execFile } from "node:child_process";

export const GH_TIMEOUT_MS = 30_000;
export const GH_MAX_BYTES = 8 * 1024 * 1024;

/** What the agent needs to know about a PR before acting on it. */
export interface PrFacts {
  number: number;
  state: string;
  merged: boolean;
  title: string;
  baseRefName: string;
  headRefName: string;
  defaultBranchName: string;
  mergeable?: string;
  url: string;
  comments: { body: string; url: string }[];
}

/** One PR as SENSING observes it - the four facts plus the cross-references found in
 *  its prose. The exact shape the server's observation seam takes, so a fetch result
 *  is reported verbatim with nothing invented in between. */
export interface ObservedPr {
  repo: string;
  number: number;
  state: "open" | "merged" | "closed";
  merged: boolean;
  checks: "passing" | "failing" | "pending" | "none";
  title: string;
  draft: boolean;
  references?: { repo: string; number: number }[];
}

export interface PrBatch {
  observed: Map<number, ObservedPr>;
  /** Remaining GraphQL rate-limit budget, when the transport reports one. */
  rateLimitRemaining?: number;
  /** Numbers the request asked for and did not get back, with why. Surfaced, never
   *  swallowed: a PR that stopped resolving is a fact about the world too. */
  missing: { number: number; why: string }[];
}

export interface Gh {
  /** Read the PR plus its comments - the facts the guards need and the marker
   *  search needs, in ONE call. */
  view(repo: string, number: number): Promise<PrFacts>;
  /** Post a comment. Returns its URL. */
  comment(repo: string, number: number, body: string): Promise<string>;
  /** Merge the PR. Returns whatever `gh` said, for the record. */
  merge(repo: string, number: number, method: string): Promise<string>;
  /**
   * SENSING's read: a whole repo's worth of PRs in one query. Read-only - the only
   * statement on this path is the `query` below, and there is no mutation text in it
   * at all. Moved here verbatim in intent from the server's deleted `fetch-gh.ts`
   * (captain decision 10), because the credentials that can read a PRIVATE pull
   * request live on this machine and nowhere else.
   */
  fetchPrs(repo: string, numbers: number[]): Promise<PrBatch>;
}

/** PRs per GraphQL query. GitHub bounds query complexity; 25 aliased PR fields is
 *  comfortably inside it and keeps one repo to one or two calls. */
export const MAX_PRS_PER_QUERY = 25;

/** Injectable process seam. `stdin` is how a comment body travels. */
export type GhRunner = (args: string[], stdin?: string) => Promise<string>;

export const runGh: GhRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.env.LOOPANY_AGENT_GH_BIN?.trim() || "gh",
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BYTES, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || "").trim().slice(0, 600);
          return reject(new Error(`${err.message}${detail ? ` - ${detail}` : ""}`));
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });

/**
 * The GraphQL read. One query for the PR's own facts, its base branch, the
 * repository's default branch and the comment bodies - because every one of those
 * is needed before deciding whether to act, and three round trips would be three
 * chances for the world to change between them.
 */
function viewQuery(repo: string, number: number): string {
  const [owner, name] = repo.split("/");
  return `query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    defaultBranchRef { name }
    pullRequest(number: ${number}) {
      number
      state
      merged
      title
      url
      baseRefName
      headRefName
      mergeable
      comments(last: 100) { nodes { body url } }
    }
  }
}`;
}

export function ghClient(runner: GhRunner = runGh): Gh {
  return {
    async view(repo, number) {
      const raw = await runner(["api", "graphql", "-f", `query=${viewQuery(repo, number)}`]);
      const body = JSON.parse(raw) as {
        data?: {
          repository?: {
            defaultBranchRef?: { name?: string } | null;
            pullRequest?: {
              number?: number;
              state?: string;
              merged?: boolean;
              title?: string;
              url?: string;
              baseRefName?: string;
              headRefName?: string;
              mergeable?: string;
              comments?: { nodes?: { body?: string; url?: string }[] };
            } | null;
          } | null;
        };
        errors?: { message?: string }[];
      };
      const pr = body.data?.repository?.pullRequest;
      if (!pr || typeof pr.number !== "number") {
        throw new Error(body.errors?.[0]?.message ?? `no pull request ${repo}#${number}`);
      }
      return {
        number: pr.number,
        state: (pr.state ?? "").toUpperCase(),
        merged: pr.merged === true,
        title: pr.title ?? "",
        baseRefName: pr.baseRefName ?? "",
        headRefName: pr.headRefName ?? "",
        defaultBranchName: body.data?.repository?.defaultBranchRef?.name ?? "",
        ...(pr.mergeable ? { mergeable: pr.mergeable.toUpperCase() } : {}),
        url: pr.url ?? `https://github.com/${repo}/pull/${pr.number}`,
        comments: (pr.comments?.nodes ?? [])
          .filter((n): n is { body?: string; url?: string } => !!n)
          .map((n) => ({ body: n.body ?? "", url: n.url ?? "" })),
      };
    },

    async comment(repo, number, body) {
      // `--body-file -` reads stdin, so the comment text never becomes argv.
      const out = await runner(
        ["pr", "comment", String(number), "--repo", repo, "--body-file", "-"],
        body,
      );
      // `gh pr comment` prints the new comment's URL.
      const url = out.trim().split(/\s+/).findLast((t) => t.startsWith("https://"));
      return url ?? "";
    },

    async merge(repo, number, method) {
      const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
      // No `--delete-branch`: cleaning up a head branch is the operator's call,
      // and doing it silently would be a second outward effect nobody approved.
      return (await runner(["pr", "merge", String(number), "--repo", repo, flag])).trim();
    },

    async fetchPrs(repo, numbers) {
      const observed = new Map<number, ObservedPr>();
      const missing: { number: number; why: string }[] = [];
      let rateLimitRemaining: number | undefined;

      for (const chunk of chunks(numbers, MAX_PRS_PER_QUERY)) {
        let body: unknown;
        try {
          body = JSON.parse(await runner(["api", "graphql", "-f", `query=${batchQuery(repo, chunk)}`]));
        } catch (err) {
          // A chunk that fails ENTIRELY reports every number in it as missing rather
          // than throwing, so one unreachable repo cannot abort a sweep over others.
          const why = err instanceof Error ? err.message : String(err);
          for (const n of chunk) missing.push({ number: n, why });
          continue;
        }
        const data = (body as { data?: { repository?: Record<string, GhPrNode | null>; rateLimit?: { remaining?: number } } })
          .data;
        const errors = (body as { errors?: { message?: string }[] }).errors;
        if (typeof data?.rateLimit?.remaining === "number") rateLimitRemaining = data.rateLimit.remaining;
        for (const n of chunk) {
          const parsed = toObserved(repo, data?.repository?.[`p${n}`]);
          if (parsed) observed.set(n, parsed);
          else missing.push({ number: n, why: errors?.[0]?.message ?? "no pullRequest node in the response" });
        }
      }
      return { observed, ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }), missing };
    },
  };
}

// ---- the sensing read: batch, parse, cross-reference ----

interface GhPrNode {
  number?: number;
  state?: string;
  merged?: boolean;
  isDraft?: boolean;
  title?: string;
  body?: string | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
}

/**
 * One aliased `pullRequest` field per number. Aliases are `p<number>`, which is a
 * legal GraphQL name and trivially reversible; the numbers are integers validated by
 * the caller, so nothing user-shaped is interpolated into the query text.
 */
export function batchQuery(repo: string, numbers: number[]): string {
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

/** GitHub's `PullRequestState` → our closed set. `merged` is also carried as its own
 *  boolean, so a disagreement between the two is visible rather than folded. */
export function toState(raw: string | undefined, merged: boolean | undefined): ObservedPr["state"] {
  const v = (raw ?? "").toUpperCase();
  if (v === "MERGED" || merged === true) return "merged";
  if (v === "CLOSED") return "closed";
  return "open";
}

/**
 * GitHub's status-check rollup → our four answers. A PR with no rollup has no CI on
 * its head commit, which is `none`; an unrecognized rollup state is `pending`, because
 * "I do not know yet" is the honest reading of a state this build has not seen and it
 * never claims green.
 */
export function toChecks(raw: string | undefined | null): ObservedPr["checks"] {
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

/** One GraphQL PR node → an `ObservedPr`, or undefined when the node is null (no such
 *  PR / no access) or carries no number to trust. Never a fabricated `closed`. */
export function toObserved(repo: string, node: GhPrNode | null | undefined): ObservedPr | undefined {
  if (!node || typeof node.number !== "number") return undefined;
  const merged = node.merged === true;
  return {
    repo,
    number: node.number,
    state: toState(node.state, merged),
    merged,
    checks: toChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    title: (node.title ?? "").trim() || `PR #${node.number}`,
    draft: node.isDraft === true,
    references: referencedPrs({ repo, number: node.number }, `${node.title ?? ""}\n${node.body ?? ""}`),
  };
}

const PR_URL_REF = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const SHORT_REF = /(?:^|[^\w/#])#(\d{1,7})\b/g;

/**
 * PRs referenced from this one's prose - a full URL anywhere, or a bare `#N` resolved
 * against the SAME repo (a `#N` in a PR body means "this repo" on GitHub, and guessing
 * any other repo would invent a fact).
 *
 * Deliberately text-only and bounded. A real cross-reference graph lives in GitHub's
 * timeline API; this is the cheap, honest subset that comes free with bytes the sweep
 * already fetched, and `max` keeps a body that lists forty PRs from turning one
 * observation into forty mirrors. The SERVER caps adoption again.
 */
export function referencedPrs(
  self: { repo: string; number: number },
  text: string | null | undefined,
  max = 5,
): { repo: string; number: number }[] {
  const body = text ?? "";
  const out: { repo: string; number: number }[] = [];
  const key = (r: string, n: number) => `${r}/pull/${n}`;
  const seen = new Set<string>([key(self.repo, self.number)]);
  const push = (repo: string, number: number) => {
    if (out.length >= max) return;
    if (!Number.isSafeInteger(number) || number <= 0) return;
    const k = key(repo, number);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ repo, number });
  };
  for (const m of body.matchAll(PR_URL_REF)) push(m[1]!, Number(m[2]));
  for (const m of body.matchAll(SHORT_REF)) push(self.repo, Number(m[1]));
  return out;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export const _internals = { viewQuery };
