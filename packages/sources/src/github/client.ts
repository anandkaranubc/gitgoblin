import { type IssueCandidate, type RepoFacts, type RepoRef, repoId } from "@gitgoblin/core";
import { z } from "zod";
import { type HttpClient, HttpError, RateLimitError, type RateLimitState } from "../http/client.ts";

const API_VERSION = "2022-11-28";
const SEARCH_TTL_MS = 10 * 60 * 1000;
const REPO_TTL_MS = 60 * 60 * 1000;
const DETAILS_TTL_MS = 60 * 60 * 1000;
// GitHub stops a GraphQL query after about ten seconds and answers 502. The details of 20 ordinary
// repositories took 10.2 s to compute, 10 took 4.7 s and 5 took 3.0 s (measured 2026-10-24).
const GRAPHQL_BATCH_SIZE = 10;
// Failed requests in a row before repoDetails stops asking. Halving a batch of 10 down to the one
// repository GitHub cannot compute takes 5 failures; a sixth means GitHub itself is failing.
const MAX_FAILURES_IN_A_ROW = 6;

/** Labels that commonly mark issues suitable for newcomers. */
export const STARTER_ISSUE_LABELS = [
  "good first issue",
  "good-first-issue",
  "help wanted",
  "help-wanted",
  "beginner",
  "beginner-friendly",
  "easy",
  "starter",
  "first-timers-only",
];

const RepoSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  html_url: z.string(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  topics: z.array(z.string()).optional(),
  language: z.string().nullish(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  created_at: z.string().optional(),
  pushed_at: z.string().nullish(),
  archived: z.boolean().optional(),
  fork: z.boolean().optional(),
  default_branch: z.string().optional(),
  size: z.number().optional(),
});

const SearchSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean().optional(),
  items: z.array(RepoSchema),
});

function toRepoFacts(raw: z.infer<typeof RepoSchema>, host: string): RepoFacts {
  return {
    host,
    owner: raw.owner.login,
    name: raw.name,
    url: raw.html_url,
    description: raw.description ?? undefined,
    homepage: raw.homepage || undefined,
    topics: raw.topics ?? [],
    language: raw.language ?? undefined,
    license: raw.license?.spdx_id ?? undefined,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    openIssues: raw.open_issues_count,
    createdAt: raw.created_at,
    pushedAt: raw.pushed_at ?? undefined,
    archived: raw.archived ?? false,
    fork: raw.fork ?? false,
    defaultBranch: raw.default_branch,
    sizeKb: raw.size,
  };
}

export interface SearchOptions {
  sort?: "stars" | "forks" | "updated" | "help-wanted-issues" | undefined;
  order?: "asc" | "desc" | undefined;
  perPage?: number | undefined;
  page?: number | undefined;
}

export interface SearchResult {
  total: number;
  items: RepoFacts[];
}

/** Repository details that only the GraphQL API provides cheaply in bulk. */
export interface GitHubRepoDetails {
  hasContributing: boolean;
  hasCodeOfConduct: boolean;
  issueTemplates: number;
  pullRequestTemplates: number;
  hasIssuesEnabled: boolean;
  archived: boolean;
  license?: string | undefined;
  diskUsageKb: number;
  starterIssues: number;
  starterIssueSamples: IssueCandidate[];
  openIssues: number;
  mergedPullRequests: number;
  lastMergedAt?: string | undefined;
  commitCount: number;
  lastCommitAt?: string | undefined;
  mentionableUsers: number;
  releases: number;
  latestReleaseAt?: string | undefined;
}

const DetailsFragment = `
fragment RepoDetails on Repository {
  isArchived hasIssuesEnabled diskUsage
  licenseInfo { spdxId }
  contributingGuidelines { url }
  codeOfConduct { name }
  issueTemplates { name }
  pullRequestTemplates { filename }
  starter: issues(states: OPEN, labels: $starterLabels, first: 5, orderBy: { field: CREATED_AT, direction: DESC }) {
    totalCount
    nodes { number title url createdAt labels(first: 10) { nodes { name } } }
  }
  openIssues: issues(states: OPEN) { totalCount }
  merged: pullRequests(states: MERGED, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
    totalCount
    nodes { mergedAt }
  }
  defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount nodes { committedDate } } } } }
  mentionableUsers { totalCount }
  releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { publishedAt } }
}`;

const DetailsNodeSchema = z.object({
  isArchived: z.boolean(),
  hasIssuesEnabled: z.boolean(),
  diskUsage: z.number().nullish(),
  licenseInfo: z.object({ spdxId: z.string().nullish() }).nullish(),
  contributingGuidelines: z.object({ url: z.string().nullish() }).nullish(),
  codeOfConduct: z.object({ name: z.string().nullish() }).nullish(),
  issueTemplates: z.array(z.unknown()).nullish(),
  pullRequestTemplates: z.array(z.unknown()).nullish(),
  starter: z.object({
    totalCount: z.number(),
    nodes: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        createdAt: z.string(),
        labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
      }),
    ),
  }),
  openIssues: z.object({ totalCount: z.number() }),
  merged: z.object({ totalCount: z.number(), nodes: z.array(z.object({ mergedAt: z.string().nullish() })) }),
  defaultBranchRef: z
    .object({
      target: z
        .object({
          history: z.object({ totalCount: z.number(), nodes: z.array(z.object({ committedDate: z.string() })) }).optional(),
        })
        .nullish(),
    })
    .nullish(),
  mentionableUsers: z.object({ totalCount: z.number() }),
  releases: z.object({ totalCount: z.number(), nodes: z.array(z.object({ publishedAt: z.string().nullish() })) }),
});

function toDetails(node: z.infer<typeof DetailsNodeSchema>): GitHubRepoDetails {
  const history = node.defaultBranchRef?.target?.history;
  return {
    hasContributing: Boolean(node.contributingGuidelines?.url),
    hasCodeOfConduct: Boolean(node.codeOfConduct?.name),
    issueTemplates: node.issueTemplates?.length ?? 0,
    pullRequestTemplates: node.pullRequestTemplates?.length ?? 0,
    hasIssuesEnabled: node.hasIssuesEnabled,
    archived: node.isArchived,
    license: node.licenseInfo?.spdxId ?? undefined,
    diskUsageKb: node.diskUsage ?? 0,
    starterIssues: node.starter.totalCount,
    starterIssueSamples: node.starter.nodes.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt,
      labels: issue.labels?.nodes.map((label) => label.name) ?? [],
    })),
    openIssues: node.openIssues.totalCount,
    mergedPullRequests: node.merged.totalCount,
    lastMergedAt: node.merged.nodes[0]?.mergedAt ?? undefined,
    commitCount: history?.totalCount ?? 0,
    lastCommitAt: history?.nodes[0]?.committedDate,
    mentionableUsers: node.mentionableUsers.totalCount,
    releases: node.releases.totalCount,
    latestReleaseAt: node.releases.nodes[0]?.publishedAt ?? undefined,
  };
}

export class GraphQLError extends Error {
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super(`GitHub GraphQL error: ${JSON.stringify(errors).slice(0, 500)}`);
    this.name = "GraphQLError";
    this.errors = errors;
  }
}

/**
 * Failures a smaller batch may get past: GitHub's 502 for a query that ran too long, other 5xx, a
 * network error or timeout on our side, and GraphQL errors without data (resource limits). Rate
 * limits, bad credentials and other 4xx answers would fail the same way for any batch.
 */
function splittable(error: unknown): boolean {
  if (error instanceof RateLimitError) return false;
  if (error instanceof HttpError) return error.status >= 500;
  if (error instanceof GraphQLError) return true;
  return !(error instanceof MissingTokenError);
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" && /^RATE_LIMIT(ED)?$/.test(type);
}

export class MissingTokenError extends Error {
  constructor(what: string) {
    super(`${what} needs a GitHub token. Set GITHUB_TOKEN or run \`gh auth login\`.`);
    this.name = "MissingTokenError";
  }
}

export interface GitHubClientOptions {
  token?: string | undefined;
  /** REST base URL; the GraphQL endpoint is derived from it. */
  baseUrl?: string | undefined;
  host?: string | undefined;
}

export interface RestOptions {
  params?: Record<string, string | number | boolean | undefined> | undefined;
  ttlMs?: number | undefined;
}

/**
 * GitHub REST and GraphQL access. Goal-specific helpers live here; the generic
 * `rest` and `graphql` methods exist so other components share the same cache
 * and rate-limit budget instead of writing their own client.
 */
export class GitHubClient {
  readonly http: HttpClient;
  readonly host: string;
  readonly #baseUrl: string;
  readonly #token: string | undefined;

  constructor(http: HttpClient, options: GitHubClientOptions = {}) {
    this.http = http;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#token = options.token;
    this.host = options.host ?? "github.com";
  }

  get authenticated(): boolean {
    return this.#token !== undefined;
  }

  /** GET any REST path ("/repos/o/n") with query params, parsed as JSON. */
  async rest<T = unknown>(path: string, options: RestOptions = {}): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.http.json<T>(url.toString(), { headers: this.#headers(), ttlMs: options.ttlMs });
  }

  /**
   * POST a GraphQL query. Requires a token. Returns the `data` object.
   *
   * GitHub answers heavy queries on busy repositories with HTTP 200, partial or
   * null nodes and a RESOURCE_LIMITS_EXCEEDED error. Partial data is returned
   * so callers can keep what they got and retry smaller; GraphQLError is
   * thrown only when there is no data at all. Other packages rely on this.
   *
   * An answer with errors and no data is not an answer: it is dropped from the
   * cache (the HTTP layer stored it as a 200) so the next call asks again, and
   * an exhausted GraphQL budget, which GitHub also reports this way, becomes a
   * RateLimitError with the reset time from the response headers.
   */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { ttlMs?: number | undefined; retries?: number | undefined } = {},
  ): Promise<T> {
    if (!this.#token) throw new MissingTokenError("The GitHub GraphQL API");
    const url = `${this.#baseUrl}/graphql`;
    const body = JSON.stringify({ query, variables });
    const response = await this.http.json<{ data?: T | null; errors?: unknown[] }>(url, {
      method: "POST",
      headers: this.#headers(),
      body,
      ttlMs: options.ttlMs,
      retries: options.retries,
    });
    if (response.data === undefined || response.data === null) {
      this.http.forget("POST", url, body);
      const errors = response.errors ?? [];
      if (errors.some(isRateLimitError)) {
        throw new RateLimitError(url, JSON.stringify(errors).slice(0, 500), this.rateLimits()["graphql"]?.resetAt);
      }
      throw new GraphQLError(errors.length ? errors : [{ message: "empty response" }]);
    }
    return response.data;
  }

  /** Rate-limit state for this host, keyed by resource ("core", "search", "graphql"). */
  rateLimits(): Record<string, RateLimitState> {
    const result: Record<string, RateLimitState> = {};
    const prefix = `${new URL(this.#baseUrl).host}/`;
    for (const [key, state] of this.http.rateLimits()) {
      if (key.startsWith(prefix)) result[key.slice(prefix.length)] = state;
    }
    return result;
  }

  async searchRepositories(q: string, options: SearchOptions = {}): Promise<SearchResult> {
    const raw = await this.rest("/search/repositories", {
      params: {
        q,
        sort: options.sort,
        order: options.order,
        per_page: options.perPage ?? 30,
        page: options.page ?? 1,
      },
      ttlMs: SEARCH_TTL_MS,
    });
    const parsed = SearchSchema.parse(raw);
    return { total: parsed.total_count, items: parsed.items.map((item) => toRepoFacts(item, this.host)) };
  }

  /** Returns undefined when the repository does not exist or is private. */
  async getRepository(ref: RepoRef): Promise<RepoFacts | undefined> {
    try {
      const raw = await this.rest(`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`, {
        ttlMs: REPO_TTL_MS,
      });
      return toRepoFacts(RepoSchema.parse(raw), this.host);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * Fetches contribution-related details for many repositories in a few GraphQL calls. Missing or
   * inaccessible repositories are left out of the map, and so are repositories whose details GitHub
   * would not compute: a batch that times out (502) or fails is split in half and asked again, down
   * to single repositories, so one heavy repository costs only its own details. After six failures in
   * a row it stops and returns what it has. It throws when nothing could be fetched, and at once for
   * rate limits and authentication errors.
   */
  async repoDetails(refs: RepoRef[]): Promise<Map<string, GitHubRepoDetails>> {
    const result = new Map<string, GitHubRepoDetails>();
    let fetched = 0;
    let failuresInARow = 0;
    let lastError: unknown;
    const pending: RepoRef[][] = [];
    for (let start = 0; start < refs.length; start += GRAPHQL_BATCH_SIZE) pending.push(refs.slice(start, start + GRAPHQL_BATCH_SIZE));
    while (pending.length > 0) {
      const batch = pending.shift() ?? [];
      try {
        // Splitting is the retry: repeating the same heavy query would only time out again.
        const data = await this.#detailsBatch(batch);
        fetched += 1;
        failuresInARow = 0;
        batch.forEach((ref, i) => {
          const node = data[`r${i}`];
          if (!node) return;
          const parsed = DetailsNodeSchema.safeParse(node);
          if (parsed.success) result.set(repoId(ref), toDetails(parsed.data));
        });
      } catch (error) {
        if (!splittable(error)) throw error;
        lastError = error;
        failuresInARow += 1;
        // GitHub itself is failing, not one heavy batch: stop instead of multiplying requests, and
        // keep what earlier batches fetched.
        if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          if (fetched === 0) throw error;
          break;
        }
        if (batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          pending.unshift(batch.slice(0, half), batch.slice(half));
        }
      }
    }
    if (fetched === 0 && lastError !== undefined) throw lastError;
    return result;
  }

  #detailsBatch(batch: RepoRef[]): Promise<Record<string, unknown>> {
    const declarations = batch.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(", ");
    const selections = batch.map((_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ...RepoDetails }`).join("\n");
    const query = `query Details(${declarations}, $starterLabels: [String!]) {\n${selections}\n}\n${DetailsFragment}`;
    const variables: Record<string, unknown> = { starterLabels: STARTER_ISSUE_LABELS };
    batch.forEach((ref, i) => {
      variables[`o${i}`] = ref.owner;
      variables[`n${i}`] = ref.name;
    });
    return this.graphql<Record<string, unknown>>(query, variables, { ttlMs: DETAILS_TTL_MS, retries: 0 });
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    return headers;
  }
}
