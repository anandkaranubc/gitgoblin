import { type IssueCandidate, type RepoFacts, type RepoRef, repoId } from "@gitgoblin/core";
import { z } from "zod";
import { type HttpClient, HttpError, type RateLimitState } from "../http/client.ts";

const API_VERSION = "2022-11-28";
const SEARCH_TTL_MS = 10 * 60 * 1000;
const REPO_TTL_MS = 60 * 60 * 1000;
const DETAILS_TTL_MS = 60 * 60 * 1000;
const GRAPHQL_BATCH_SIZE = 20;

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
   */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { ttlMs?: number | undefined } = {},
  ): Promise<T> {
    if (!this.#token) throw new MissingTokenError("The GitHub GraphQL API");
    const body = JSON.stringify({ query, variables });
    const response = await this.http.json<{ data?: T; errors?: unknown[] }>(`${this.#baseUrl}/graphql`, {
      method: "POST",
      headers: this.#headers(),
      body,
      ttlMs: options.ttlMs,
    });
    if (response.errors?.length && response.data === undefined) throw new GraphQLError(response.errors);
    if (response.data === undefined) throw new GraphQLError([{ message: "empty response" }]);
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
   * Fetches contribution-related details for many repositories in a few
   * GraphQL calls. Missing or inaccessible repositories are left out of the map.
   */
  async repoDetails(refs: RepoRef[]): Promise<Map<string, GitHubRepoDetails>> {
    const result = new Map<string, GitHubRepoDetails>();
    for (let start = 0; start < refs.length; start += GRAPHQL_BATCH_SIZE) {
      const batch = refs.slice(start, start + GRAPHQL_BATCH_SIZE);
      const declarations = batch.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(", ");
      const selections = batch.map((_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ...RepoDetails }`).join("\n");
      const query = `query Details(${declarations}, $starterLabels: [String!]) {\n${selections}\n}\n${DetailsFragment}`;
      const variables: Record<string, unknown> = { starterLabels: STARTER_ISSUE_LABELS };
      batch.forEach((ref, i) => {
        variables[`o${i}`] = ref.owner;
        variables[`n${i}`] = ref.name;
      });
      const data = await this.graphql<Record<string, unknown>>(query, variables, { ttlMs: DETAILS_TTL_MS });
      batch.forEach((ref, i) => {
        const node = data[`r${i}`];
        if (!node) return;
        const parsed = DetailsNodeSchema.safeParse(node);
        if (parsed.success) result.set(repoId(ref), toDetails(parsed.data));
      });
    }
    return result;
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
