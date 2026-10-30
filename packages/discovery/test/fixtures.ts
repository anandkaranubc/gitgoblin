import type { RepoFacts } from "@gitgoblin/core";
import type { EcosystemsIssueStats, EcosystemsPackage, EcosystemsRepo, GitHubRepoDetails } from "@gitgoblin/sources";
import type { EnrichedRepo } from "../src/index.ts";

export const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 86_400_000;

export function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

export function facts(overrides: Partial<RepoFacts> & { owner: string; name: string }): RepoFacts {
  return {
    host: "github.com",
    url: `https://github.com/${overrides.owner}/${overrides.name}`,
    description: "A reasonably descriptive summary of what this project does",
    topics: [],
    stars: 100,
    forks: 10,
    openIssues: 5,
    createdAt: daysAgo(900),
    pushedAt: daysAgo(3),
    archived: false,
    fork: false,
    license: "MIT",
    ...overrides,
  };
}

export function ecosystems(overrides: Partial<EcosystemsRepo> = {}): EcosystemsRepo {
  return {
    fullName: "x/y",
    stars: 100,
    forks: 10,
    openIssues: 5,
    subscribers: 5,
    archived: false,
    fork: false,
    topics: [],
    tagsCount: 12,
    files: { readme: "README.md", contributing: "CONTRIBUTING.md", changelog: "CHANGELOG.md" },
    hasFunding: false,
    commitStats: { totalCommits: 800, totalCommitters: 60, meanCommits: 13, dds: 0.55 },
    ...overrides,
  };
}

export function pkg(overrides: Partial<EcosystemsPackage> = {}): EcosystemsPackage {
  return {
    name: "thing",
    ecosystem: "npm",
    keywords: ["things"],
    registry: "npmjs.org",
    dependentPackages: 300,
    dependentRepos: 20_000,
    downloads: 2_000_000,
    downloadsPeriod: "last-month",
    versions: 40,
    ...overrides,
  };
}

export function issueStats(overrides: Partial<EcosystemsIssueStats> = {}): EcosystemsIssueStats {
  return {
    issues: 400,
    pullRequests: 300,
    mergedPullRequests: 240,
    avgTimeToCloseIssueSec: 5 * 86_400,
    avgTimeToClosePrSec: 2 * 86_400,
    pastYear: {
      issues: 80,
      pullRequests: 60,
      mergedPullRequests: 50,
      avgTimeToCloseIssueSec: 3 * 86_400,
      avgTimeToClosePrSec: 1.5 * 86_400,
      prAuthors: 25,
      issueAuthors: 40,
    },
    ...overrides,
  };
}

export function details(overrides: Partial<GitHubRepoDetails> = {}): GitHubRepoDetails {
  return {
    hasContributing: true,
    hasCodeOfConduct: true,
    issueTemplates: 2,
    hasIssuesEnabled: true,
    archived: false,
    license: "MIT",
    starterIssues: 7,
    starterIssueSamples: [
      { number: 42, title: "Add --color flag", url: "https://github.com/x/y/issues/42", labels: ["good first issue"], createdAt: daysAgo(10) },
    ],
    openIssues: 30,
    mergedPullRequests: 240,
    lastMergedAt: daysAgo(2),
    commitCount: 800,
    lastCommitAt: daysAgo(1),
    mentionableUsers: 60,
    releases: 25,
    latestReleaseAt: daysAgo(20),
    ...overrides,
  };
}

/** A healthy, welcoming, widely used library. */
export function healthyLibrary(): EnrichedRepo {
  return {
    facts: facts({ owner: "good", name: "lib", stars: 5000, forks: 400, createdAt: daysAgo(4 * 365), pushedAt: daysAgo(2), homepage: "https://good.dev" }),
    ecosystems: ecosystems({ files: { readme: "README.md", contributing: "CONTRIBUTING.md", code_of_conduct: "CODE_OF_CONDUCT.md", changelog: "CHANGELOG.md" }, commitStats: { totalCommits: 3000, totalCommitters: 120, meanCommits: 25, dds: 0.6 } }),
    packages: [pkg({ name: "good-lib" })],
    issueStats: issueStats(),
    details: details(),
  };
}

/** Widely depended on, but nobody has pushed for three years. */
export function abandonedLibrary(): EnrichedRepo {
  return {
    facts: facts({ owner: "gone", name: "lib", stars: 2000, forks: 500, openIssues: 140, createdAt: daysAgo(8 * 365), pushedAt: daysAgo(3 * 365) }),
    ecosystems: ecosystems({ commitStats: { totalCommits: 400, totalCommitters: 8, meanCommits: 50, dds: 0.2 } }),
    packages: [pkg({ name: "gone-mirror", ecosystem: "go", dependentRepos: 3 }), pkg({ name: "gone-lib", dependentRepos: 50_000, dependentPackages: 900 })],
    issueStats: issueStats({ pastYear: { issues: 20, pullRequests: 6, mergedPullRequests: 0, prAuthors: 6, issueAuthors: 18 } }),
  };
}

/** Three weeks old, no license, a handful of stars, pushed yesterday. */
export function tinyNewProject(): EnrichedRepo {
  return {
    facts: facts({ owner: "newbie", name: "toy", stars: 15, forks: 1, openIssues: 1, createdAt: daysAgo(21), pushedAt: daysAgo(1), license: undefined, description: "wip" }),
    ecosystems: ecosystems({ files: { readme: "README.md" }, commitStats: { totalCommits: 30, totalCommitters: 1, meanCommits: 30, dds: 0 }, tagsCount: 0 }),
    packages: [],
  };
}
