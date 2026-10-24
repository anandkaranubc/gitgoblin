/**
 * GitHub GraphQL history for one repository: pull requests, issues, commits
 * up to a date and releases. Responses go through the shared HTTP cache of
 * `@gitgoblin/sources` with a long TTL, so a snapshot can be re-derived
 * offline once fetched.
 */
import { type GitHubClient, GraphQLError, RateLimitError } from "@gitgoblin/sources";
import type { IssueRow, PrRow } from "../outcomes.ts";
import { MAINTAINER_ASSOCIATIONS } from "../outcomes.ts";

export const HISTORY_TTL_MS = 90 * 24 * 3_600_000;

const BOT_LOGINS = new Set([
  "dependabot", "renovate", "renovate-bot", "github-actions", "codecov", "codecov-io", "coveralls",
  "greenkeeper", "snyk-bot", "pre-commit-ci", "allcontributors", "stale", "mergify", "netlify",
  "vercel", "sonarcloud", "imgbot", "pyup-bot", "copilot", "copilot-swe-agent", "devin-ai-integration",
]);

interface Actor {
  login: string;
  __typename: string;
}

export function isBot(actor: Actor | null | undefined): boolean {
  if (!actor) return false;
  const login = actor.login.toLowerCase();
  return actor.__typename === "Bot" || login.endsWith("[bot]") || login.endsWith("-bot") || BOT_LOGINS.has(login);
}

const PR_PAGE = /* GraphQL */ `
query PrHistory($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt mergedAt closedAt state additions deletions changedFiles authorAssociation
        author { login __typename }
        closingIssuesReferences(first: 1) { totalCount }
        reviews(first: 1) { nodes { createdAt author { login __typename } } }
        comments(first: 2) { nodes { createdAt author { login __typename } } }
      }
    }
  }
}`;

const ISSUE_PAGE = /* GraphQL */ `
query IssueHistory($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt closedAt stateReason authorAssociation
        author { login __typename }
        labels(first: 6) { nodes { name } }
        closedByPullRequestsReferences(first: 1) { nodes { merged authorAssociation author { login __typename } } }
      }
    }
  }
}`;

const META = /* GraphQL */ `
query HistoryMeta($owner: String!, $name: String!, $until: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { history(first: 1, until: $until) { totalCount nodes { committedDate } } } } }
    releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { publishedAt } }
  }
}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface PrNode {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  additions: number;
  deletions: number;
  changedFiles: number;
  authorAssociation: string;
  author: Actor | null;
  closingIssuesReferences: { totalCount: number };
  reviews: { nodes: { createdAt: string; author: Actor | null }[] };
  comments: { nodes: { createdAt: string; author: Actor | null }[] };
  labels?: { nodes: { name: string }[] } | undefined;
}

interface IssueNode {
  number: number;
  createdAt: string;
  closedAt: string | null;
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | null;
  authorAssociation: string;
  author: Actor | null;
  labels: { nodes: { name: string }[] };
  closedByPullRequestsReferences: { nodes: { merged: boolean; authorAssociation: string; author: Actor | null }[] };
}

export function toPrRow(node: PrNode): PrRow {
  const author = node.author?.login;
  const responses = [...node.reviews.nodes, ...node.comments.nodes]
    .filter((r) => r.author && r.author.login !== author && !isBot(r.author))
    .map((r) => r.createdAt)
    .sort();
  return {
    number: node.number,
    createdAt: node.createdAt,
    mergedAt: node.mergedAt ?? undefined,
    closedAt: node.closedAt ?? undefined,
    state: node.state,
    author,
    authorIsBot: isBot(node.author),
    association: node.authorAssociation,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    linkedIssues: node.closingIssuesReferences.totalCount,
    firstResponseAt: responses[0],
    labels: node.labels?.nodes.map((l) => l.name) ?? [],
  };
}

export function toIssueRow(node: IssueNode): IssueRow {
  const closer = node.closedByPullRequestsReferences.nodes.find((p) => p.merged);
  return {
    number: node.number,
    createdAt: node.createdAt,
    closedAt: node.closedAt ?? undefined,
    stateReason: node.stateReason,
    author: node.author?.login,
    authorIsBot: isBot(node.author),
    association: node.authorAssociation,
    labels: node.labels.nodes.map((l) => l.name),
    closedByPr: !closer ? "none" : isBot(closer.author) || MAINTAINER_ASSOCIATIONS.has(closer.authorAssociation) ? "maintainer" : "outsider",
  };
}

export interface RepoHistory {
  prs: PrRow[];
  issues: IssueRow[];
  commitsBefore: { count: number; lastAt?: string | undefined };
  releasesBefore: { count: number; latestAt?: string | undefined };
  /** Creation date of the oldest pull request fetched. */
  historyStart: string | undefined;
  /** True when paging stopped at the page cap before reaching `since`. */
  prsTruncated: boolean;
  issuesTruncated: boolean;
}

export interface HistoryOptions {
  /** Fetch items created on or after this date (ISO). */
  since: string;
  /** Commits and releases are counted up to this date. */
  asOf: string;
  maxPrPages?: number | undefined;
  maxIssuePages?: number | undefined;
  log?: ((message: string) => void) | undefined;
}

/** GitHub reports an exhausted GraphQL budget either as HTTP 403 (RateLimitError) or as a 200 carrying a RATE_LIMIT error. */
export function rateLimitResetAt(error: unknown, fallbackResetAt?: Date | undefined): Date | undefined {
  if (error instanceof RateLimitError) return error.resetAt ?? fallbackResetAt ?? new Date(Date.now() + 60_000);
  if (error instanceof GraphQLError && error.errors.some((e) => (e as { type?: string }).type === "RATE_LIMIT")) return fallbackResetAt ?? new Date(Date.now() + 60_000);
  return undefined;
}

/** Waits beyond this many are a sign the error is not really about the budget; give up on the item instead of spinning. */
const MAX_RATE_LIMIT_WAITS = 6;

/** Network outages (sleep, Wi-Fi drops) are waited out for up to this many minutes before an item fails. */
const MAX_OUTAGE_MINUTES = 30;

export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(`${error.message} ${(error as { cause?: { code?: string } }).cause?.code ?? ""}`);
}

export async function withRateLimitRetry<T>(fn: () => Promise<T>, log: (m: string) => void, resetHint?: (() => Date | undefined) | undefined): Promise<T> {
  let emptyBodies = 0;
  let waits = 0;
  let outageMinutes = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (isNetworkError(error) && outageMinutes < MAX_OUTAGE_MINUTES) {
        if (outageMinutes === 0) log("network unavailable; retrying every minute");
        outageMinutes++;
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        continue;
      }
      // GitHub occasionally answers with an empty body; one retry is enough in practice.
      if (error instanceof SyntaxError && emptyBodies++ < 2) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      const resetAt = rateLimitResetAt(error, resetHint?.());
      if (!resetAt || ++waits > MAX_RATE_LIMIT_WAITS) throw error;
      const waitMs = Math.min(3_600_000, Math.max(5_000, resetAt.getTime() - Date.now() + 5_000));
      log(`rate limited; waiting ${Math.round(waitMs / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** When the budget is gone, the client's last seen headers say when it comes back. */
export function graphqlReset(github: GitHubClient): () => Date | undefined {
  return () => github.rateLimits().graphql?.resetAt;
}

async function page<N extends { createdAt: string }>(
  github: GitHubClient,
  query: string,
  owner: string,
  name: string,
  pick: (data: unknown) => { pageInfo: PageInfo; nodes: (N | null)[] } | undefined,
  since: string,
  maxPages: number,
  log: (m: string) => void,
): Promise<{ nodes: N[]; truncated: boolean }> {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let p = 0; p < maxPages; p++) {
    const data = await withRateLimitRetry(() => github.graphql<unknown>(query, { owner, name, after }, { ttlMs: HISTORY_TTL_MS }), log, graphqlReset(github));
    const conn = pick(data);
    if (!conn) break;
    for (const node of conn.nodes) if (node) nodes.push(node);
    const oldest = conn.nodes.at(-1)?.createdAt;
    if (!conn.pageInfo.hasNextPage || (oldest !== undefined && oldest < since)) return { nodes, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}

export async function fetchHistory(github: GitHubClient, owner: string, name: string, options: HistoryOptions): Promise<RepoHistory> {
  const log = options.log ?? (() => {});
  const prs = await page<PrNode>(github, PR_PAGE, owner, name, (d) => (d as { repository?: { pullRequests: { pageInfo: PageInfo; nodes: PrNode[] } } }).repository?.pullRequests, options.since, options.maxPrPages ?? 6, log);
  const issues = await page<IssueNode>(github, ISSUE_PAGE, owner, name, (d) => (d as { repository?: { issues: { pageInfo: PageInfo; nodes: IssueNode[] } } }).repository?.issues, options.since, options.maxIssuePages ?? 3, log);
  const meta = await withRateLimitRetry(
    () =>
      github.graphql<{
        repository: {
          defaultBranchRef: { target: { history?: { totalCount: number; nodes: { committedDate: string }[] } } | null } | null;
          releases: { totalCount: number; nodes: { publishedAt: string | null }[] };
        } | null;
      }>(META, { owner, name, until: options.asOf }, { ttlMs: HISTORY_TTL_MS }),
    log,
    graphqlReset(github),
  );
  const history = meta.repository?.defaultBranchRef?.target?.history;
  const asOf = Date.parse(options.asOf);
  const releasesBefore = (meta.repository?.releases.nodes ?? []).map((r) => r.publishedAt).filter((d): d is string => d !== null && Date.parse(d) < asOf).sort();
  const prRows = prs.nodes.map(toPrRow);
  return {
    prs: prRows,
    issues: issues.nodes.map(toIssueRow),
    commitsBefore: { count: history?.totalCount ?? 0, lastAt: history?.nodes[0]?.committedDate },
    releasesBefore: { count: releasesBefore.length, latestAt: releasesBefore.at(-1) },
    historyStart: prRows.map((pr) => pr.createdAt).sort()[0],
    prsTruncated: prs.truncated,
    issuesTruncated: issues.truncated,
  };
}

const COMMIT_AT = /* GraphQL */ `
query CommitAt($owner: String!, $name: String!, $until: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { ... on Commit { history(first: 1, until: $until) { nodes { oid committedDate } } } } }
  }
}`;

/** The default-branch commit as of a date. */
export async function commitAt(github: GitHubClient, owner: string, name: string, asOf: string): Promise<{ sha: string; committedDate: string; branch: string } | undefined> {
  const data = await withRateLimitRetry(
    () => github.graphql<{ repository: { defaultBranchRef: { name: string; target: { history?: { nodes: { oid: string; committedDate: string }[] } } | null } | null } | null }>(COMMIT_AT, { owner, name, until: asOf }, { ttlMs: HISTORY_TTL_MS }),
    () => {},
    graphqlReset(github),
  );
  const ref = data.repository?.defaultBranchRef;
  const node = ref?.target?.history?.nodes[0];
  return node && ref ? { sha: node.oid, committedDate: node.committedDate, branch: ref.name } : undefined;
}

const LABELED_ISSUES = /* GraphQL */ `
query LabeledIssues($owner: String!, $name: String!, $labels: [String!]!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, labels: $labels, states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt closedAt stateReason authorAssociation
        author { login __typename }
        labels(first: 10) { nodes { name } }
        closedByPullRequestsReferences(first: 2) { nodes { merged authorAssociation author { login __typename } } }
      }
    }
  }
}`;

/** Issues carrying any of `labels`, newest first, up to `maxPages` pages. */
export async function fetchLabeledIssues(github: GitHubClient, owner: string, name: string, labels: string[], maxPages = 3): Promise<IssueRow[]> {
  const rows: IssueRow[] = [];
  let after: string | null = null;
  for (let p = 0; p < maxPages; p++) {
    const data = await withRateLimitRetry(
      () => github.graphql<{ repository: { issues: { pageInfo: PageInfo; nodes: (IssueNode | null)[] } } | null }>(LABELED_ISSUES, { owner, name, labels, after }, { ttlMs: HISTORY_TTL_MS }),
      () => {},
      graphqlReset(github),
    );
    const conn = data.repository?.issues;
    if (!conn) break;
    for (const node of conn.nodes) if (node) rows.push(toIssueRow(node));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return rows;
}

/** Paths changed by each pull request, in one query per 10 pull requests. */
export async function fetchPrFiles(github: GitHubClient, owner: string, name: string, numbers: number[]): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  for (let start = 0; start < numbers.length; start += 10) {
    const batch = numbers.slice(start, start + 10);
    const selections = batch.map((n, i) => `p${i}: pullRequest(number: ${n}) { number files(first: 30) { nodes { path } } }`).join("\n");
    const query = `query PrFiles($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selections} } }`;
    const data = await withRateLimitRetry(() => github.graphql<{ repository: Record<string, { number: number; files: { nodes: { path: string }[] } } | null> | null }>(query, { owner, name }, { ttlMs: HISTORY_TTL_MS }), () => {}, graphqlReset(github));
    for (const node of Object.values(data.repository ?? {})) if (node) result.set(node.number, node.files.nodes.map((f) => f.path));
  }
  return result;
}
