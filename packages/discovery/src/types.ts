import type { RepoFacts, RepoRef } from "@gitgoblin/core";
import type {
  EcosystemsIssueStats,
  EcosystemsPackage,
  EcosystemsRepo,
  GitHubRepoDetails,
  SearchOptions,
  SearchResult,
} from "@gitgoblin/sources";

/** Everything we managed to learn about one repository. Missing parts mean "unknown". */
export interface EnrichedRepo {
  facts: RepoFacts;
  ecosystems?: EcosystemsRepo | undefined;
  packages?: EcosystemsPackage[] | undefined;
  issueStats?: EcosystemsIssueStats | undefined;
  details?: GitHubRepoDetails | undefined;
}

/** The slice of GitHub access the engine needs. `GitHubClient` satisfies it; tests use fakes. */
export interface GitHubSource {
  readonly authenticated: boolean;
  searchRepositories(q: string, options?: SearchOptions): Promise<SearchResult>;
  getRepository(ref: RepoRef): Promise<RepoFacts | undefined>;
  repoDetails(refs: RepoRef[]): Promise<Map<string, GitHubRepoDetails>>;
}

/** The slice of ecosyste.ms access the engine needs. `EcosystemsClient` satisfies it. */
export interface EcosystemsSource {
  lookupRepository(ref: RepoRef): Promise<EcosystemsRepo | undefined>;
  lookupPackages(ref: RepoRef): Promise<EcosystemsPackage[]>;
  lookupIssueStats(ref: RepoRef): Promise<EcosystemsIssueStats | undefined>;
}
