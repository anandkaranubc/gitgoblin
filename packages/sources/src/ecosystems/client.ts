import { normalizeHost, type RepoRef, repoUrl } from "@gitgoblin/core";
import { z } from "zod";
import { type HttpClient, HttpError } from "../http/client.ts";

const TTL_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 6 * 60 * 60 * 1000;

const RepoSchema = z.object({
  full_name: z.string(),
  description: z.string().nullish(),
  stargazers_count: z.number().nullish(),
  forks_count: z.number().nullish(),
  open_issues_count: z.number().nullish(),
  subscribers_count: z.number().nullish(),
  pushed_at: z.string().nullish(),
  created_at: z.string().nullish(),
  archived: z.boolean().nullish(),
  fork: z.boolean().nullish(),
  language: z.string().nullish(),
  license: z.string().nullish(),
  topics: z.array(z.string()).nullish(),
  homepage: z.string().nullish(),
  tags_count: z.number().nullish(),
  last_synced_at: z.string().nullish(),
  status: z.string().nullish(),
  commit_stats: z
    .object({
      total_commits: z.number().nullish(),
      total_committers: z.number().nullish(),
      mean_commits: z.number().nullish(),
      dds: z.number().nullish(),
    })
    .nullish(),
  metadata: z
    .object({
      files: z.record(z.string(), z.string().nullish()).nullish(),
      funding: z.unknown().nullish(),
    })
    .nullish(),
  scorecard: z.object({ data: z.object({ score: z.number().nullish() }).nullish() }).nullish(),
});

/** Repository facts and commit statistics as indexed by repos.ecosyste.ms. */
export interface EcosystemsRepo {
  fullName: string;
  description?: string | undefined;
  stars: number;
  forks: number;
  openIssues: number;
  subscribers: number;
  pushedAt?: string | undefined;
  createdAt?: string | undefined;
  archived: boolean;
  fork: boolean;
  language?: string | undefined;
  license?: string | undefined;
  topics: string[];
  homepage?: string | undefined;
  tagsCount: number;
  lastSyncedAt?: string | undefined;
  commitStats?:
    | {
        totalCommits: number;
        totalCommitters: number;
        meanCommits: number;
        /** Development distribution score, 0..1. Higher means work is spread across more people. */
        dds?: number | undefined;
      }
    | undefined;
  /** Community files found in the repo, keyed by kind ("readme", "contributing", "code_of_conduct"...). */
  files: Record<string, string>;
  hasFunding: boolean;
  /** OpenSSF Scorecard aggregate, 0..10. */
  scorecardScore?: number | undefined;
}

function toRepo(raw: z.infer<typeof RepoSchema>): EcosystemsRepo {
  const files: Record<string, string> = {};
  for (const [kind, path] of Object.entries(raw.metadata?.files ?? {})) {
    if (path) files[kind] = path;
  }
  const stats = raw.commit_stats;
  const funding = raw.metadata?.funding;
  return {
    fullName: raw.full_name,
    description: raw.description ?? undefined,
    stars: raw.stargazers_count ?? 0,
    forks: raw.forks_count ?? 0,
    openIssues: raw.open_issues_count ?? 0,
    subscribers: raw.subscribers_count ?? 0,
    pushedAt: raw.pushed_at ?? undefined,
    createdAt: raw.created_at ?? undefined,
    archived: raw.archived ?? false,
    fork: raw.fork ?? false,
    language: raw.language ?? undefined,
    license: raw.license ?? undefined,
    topics: raw.topics ?? [],
    homepage: raw.homepage || undefined,
    tagsCount: raw.tags_count ?? 0,
    lastSyncedAt: raw.last_synced_at ?? undefined,
    commitStats: stats
      ? {
          totalCommits: stats.total_commits ?? 0,
          totalCommitters: stats.total_committers ?? 0,
          meanCommits: stats.mean_commits ?? 0,
          dds: stats.dds ?? undefined,
        }
      : undefined,
    files,
    hasFunding: Boolean(funding && typeof funding === "object" && Object.keys(funding).length > 0),
    scorecardScore: raw.scorecard?.data?.score ?? undefined,
  };
}

const PackageSchema = z.object({
  name: z.string(),
  ecosystem: z.string(),
  keywords_array: z.array(z.string()).nullish(),
  registry: z.object({ name: z.string() }).nullish(),
  repository_url: z.string().nullish(),
  dependent_packages_count: z.number().nullish(),
  dependent_repos_count: z.number().nullish(),
  downloads: z.number().nullish(),
  downloads_period: z.string().nullish(),
  latest_release_published_at: z.string().nullish(),
  versions_count: z.number().nullish(),
  status: z.string().nullish(),
  critical: z.boolean().nullish(),
  rankings: z.object({ average: z.number().nullish() }).nullish(),
});

/** A published package built from a repository, as indexed by packages.ecosyste.ms. */
export interface EcosystemsPackage {
  name: string;
  ecosystem: string;
  keywords: string[];
  registry?: string | undefined;
  repositoryUrl?: string | undefined;
  dependentPackages: number;
  dependentRepos: number;
  downloads: number;
  downloadsPeriod?: string | undefined;
  latestReleaseAt?: string | undefined;
  versions: number;
  status?: string | undefined;
  critical: boolean;
  /** Average percentile across the registry (0 is best). */
  rankingAverage?: number | undefined;
}

function toPackage(raw: z.infer<typeof PackageSchema>): EcosystemsPackage {
  return {
    name: raw.name,
    ecosystem: raw.ecosystem,
    keywords: raw.keywords_array ?? [],
    registry: raw.registry?.name,
    repositoryUrl: raw.repository_url ?? undefined,
    dependentPackages: raw.dependent_packages_count ?? 0,
    dependentRepos: raw.dependent_repos_count ?? 0,
    downloads: raw.downloads ?? 0,
    downloadsPeriod: raw.downloads_period ?? undefined,
    latestReleaseAt: raw.latest_release_published_at ?? undefined,
    versions: raw.versions_count ?? 0,
    status: raw.status ?? undefined,
    critical: raw.critical ?? false,
    rankingAverage: raw.rankings?.average ?? undefined,
  };
}

const IssueStatsSchema = z.object({
  issues_count: z.number().nullish(),
  pull_requests_count: z.number().nullish(),
  merged_pull_requests_count: z.number().nullish(),
  avg_time_to_close_issue: z.number().nullish(),
  avg_time_to_close_pull_request: z.number().nullish(),
  past_year_issues_count: z.number().nullish(),
  past_year_pull_requests_count: z.number().nullish(),
  past_year_merged_pull_requests_count: z.number().nullish(),
  past_year_avg_time_to_close_issue: z.number().nullish(),
  past_year_avg_time_to_close_pull_request: z.number().nullish(),
  past_year_pull_request_authors_count: z.number().nullish(),
  past_year_issue_authors_count: z.number().nullish(),
  last_synced_at: z.string().nullish(),
});

/** Issue and pull-request statistics from issues.ecosyste.ms. Durations are seconds. */
export interface EcosystemsIssueStats {
  issues: number;
  pullRequests: number;
  mergedPullRequests: number;
  avgTimeToCloseIssueSec?: number | undefined;
  avgTimeToClosePrSec?: number | undefined;
  pastYear: {
    issues: number;
    pullRequests: number;
    mergedPullRequests: number;
    avgTimeToCloseIssueSec?: number | undefined;
    avgTimeToClosePrSec?: number | undefined;
    prAuthors: number;
    issueAuthors: number;
  };
  lastSyncedAt?: string | undefined;
}

function toIssueStats(raw: z.infer<typeof IssueStatsSchema>): EcosystemsIssueStats {
  return {
    issues: raw.issues_count ?? 0,
    pullRequests: raw.pull_requests_count ?? 0,
    mergedPullRequests: raw.merged_pull_requests_count ?? 0,
    avgTimeToCloseIssueSec: raw.avg_time_to_close_issue ?? undefined,
    avgTimeToClosePrSec: raw.avg_time_to_close_pull_request ?? undefined,
    pastYear: {
      issues: raw.past_year_issues_count ?? 0,
      pullRequests: raw.past_year_pull_requests_count ?? 0,
      mergedPullRequests: raw.past_year_merged_pull_requests_count ?? 0,
      avgTimeToCloseIssueSec: raw.past_year_avg_time_to_close_issue ?? undefined,
      avgTimeToClosePrSec: raw.past_year_avg_time_to_close_pull_request ?? undefined,
      prAuthors: raw.past_year_pull_request_authors_count ?? 0,
      issueAuthors: raw.past_year_issue_authors_count ?? 0,
    },
    lastSyncedAt: raw.last_synced_at ?? undefined,
  };
}

export interface EcosystemsClientOptions {
  reposBaseUrl?: string | undefined;
  packagesBaseUrl?: string | undefined;
  issuesBaseUrl?: string | undefined;
}

/**
 * Client for the ecosyste.ms family of open APIs, which index repositories
 * across GitHub, GitLab, Codeberg and ~100 other forges, plus package
 * registries. No authentication is needed; responses are cached for a day.
 */
export class EcosystemsClient {
  readonly http: HttpClient;
  readonly #repos: string;
  readonly #packages: string;
  readonly #issues: string;

  constructor(http: HttpClient, options: EcosystemsClientOptions = {}) {
    this.http = http;
    this.#repos = options.reposBaseUrl ?? "https://repos.ecosyste.ms";
    this.#packages = options.packagesBaseUrl ?? "https://packages.ecosyste.ms";
    this.#issues = options.issuesBaseUrl ?? "https://issues.ecosyste.ms";
  }

  async lookupRepository(ref: RepoRef): Promise<EcosystemsRepo | undefined> {
    const raw = await this.#lookup(this.#repositoryUrl(this.#repos, ref));
    if (raw === undefined) return undefined;
    const parsed = RepoSchema.safeParse(raw);
    return parsed.success ? toRepo(parsed.data) : undefined;
  }

  /** Packages published from this repository across all registries. Empty when none are known. */
  async lookupPackages(ref: RepoRef): Promise<EcosystemsPackage[]> {
    const raw = await this.#lookup(
      `${this.#packages}/api/v1/packages/lookup?repository_url=${encodeURIComponent(repoUrl(ref))}`,
    );
    const parsed = z.array(PackageSchema).safeParse(raw ?? []);
    return parsed.success ? parsed.data.map(toPackage) : [];
  }

  async lookupIssueStats(ref: RepoRef): Promise<EcosystemsIssueStats | undefined> {
    const raw = await this.#lookup(this.#repositoryUrl(this.#issues, ref));
    if (raw === undefined) return undefined;
    const parsed = IssueStatsSchema.safeParse(raw);
    return parsed.success ? toIssueStats(parsed.data) : undefined;
  }

  /**
   * ecosyste.ms names GitHub "GitHub" and other forges by hostname. The direct
   * host route skips a redirect the generic lookup needs, so it is much faster.
   */
  #repositoryUrl(base: string, ref: RepoRef): string {
    const host = normalizeHost(ref.host);
    const hostName = host === "github.com" ? "GitHub" : host;
    if (host === "github.com" || host === "gitlab.com") {
      return `${base}/api/v1/hosts/${encodeURIComponent(hostName)}/repositories/${encodeURIComponent(`${ref.owner}/${ref.name}`)}`;
    }
    return `${base}/api/v1/repositories/lookup?url=${encodeURIComponent(repoUrl(ref))}`;
  }

  async #lookup(url: string): Promise<unknown> {
    try {
      return await this.http.json(url, { ttlMs: TTL_MS, notFoundTtlMs: NOT_FOUND_TTL_MS });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }
}
