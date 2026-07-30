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

export interface Gh {
  /** Read the PR plus its comments - the facts the guards need and the marker
   *  search needs, in ONE call. */
  view(repo: string, number: number): Promise<PrFacts>;
  /** Post a comment. Returns its URL. */
  comment(repo: string, number: number, body: string): Promise<string>;
  /** Merge the PR. Returns whatever `gh` said, for the record. */
  merge(repo: string, number: number, method: string): Promise<string>;
}

/** Injectable process seam. `stdin` is how a comment body travels. */
export type GhRunner = (args: string[], stdin?: string) => Promise<string>;

export const runGh: GhRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.env.LOOPANY_GH_BIN?.trim() || "gh",
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
  };
}

export const _internals = { viewQuery };
