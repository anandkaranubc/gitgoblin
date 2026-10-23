/**
 * Rebuilds discovery's `EnrichedRepo` as it would have looked at a past date
 * from pull request, issue, commit and release history, so discovery's own
 * `scoreRepo` can be run on the past without touching its code.
 *
 * Facts that cannot be reconstructed (stars, forks, topics, community files,
 * committer statistics) are passed through from the present; the experiment
 * reports that as a known leak shared by every baseline.
 */
import type { RepoFacts } from "@gitgoblin/core";
import type { EnrichedRepo } from "@gitgoblin/discovery";
import type { EcosystemsIssueStats, EcosystemsRepo, GitHubRepoDetails } from "@gitgoblin/sources";
import type { IssueRow, PrRow } from "./outcomes.ts";

export interface HistoryAsOf {
  prs: PrRow[];
  issues: IssueRow[];
  /** Default-branch commits up to T. */
  commitsBefore: { count: number; lastAt?: string | undefined };
  /** Releases published before T. */
  releasesBefore: { count: number; latestAt?: string | undefined };
}

export interface CurrentView {
  facts: RepoFacts;
  ecosystems?: EcosystemsRepo | undefined;
  details?: GitHubRepoDetails | undefined;
}

const DAY_MS = 86_400_000;

function before(iso: string | undefined, t: number): boolean {
  return iso !== undefined && Date.parse(iso) < t;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : undefined;
}

export function enrichedAsOf(current: CurrentView, history: HistoryAsOf, asOf: string, starterLabels: string[]): EnrichedRepo {
  const t = Date.parse(asOf);
  const yearStart = t - 365 * DAY_MS;
  const starter = new Set(starterLabels.map((l) => l.toLowerCase()));

  const facts: RepoFacts = { ...current.facts, pushedAt: history.commitsBefore.lastAt };

  const mergedBefore = history.prs.filter((pr) => before(pr.mergedAt, t));
  const lastMergedAt = mergedBefore.map((pr) => pr.mergedAt!).sort().at(-1);
  const openAtT = history.issues.filter((i) => before(i.createdAt, t) && !before(i.closedAt, t));
  const starterAtT = openAtT.filter((i) => i.labels.some((l) => starter.has(l.toLowerCase())));

  const details: GitHubRepoDetails | undefined = current.details
    ? {
        ...current.details,
        starterIssues: starterAtT.length,
        starterIssueSamples: [],
        mergedPullRequests: mergedBefore.length,
        lastMergedAt,
        commitCount: history.commitsBefore.count,
        lastCommitAt: history.commitsBefore.lastAt,
        releases: history.releasesBefore.count,
        latestReleaseAt: history.releasesBefore.latestAt,
      }
    : undefined;

  const yearPrs = history.prs.filter((pr) => Date.parse(pr.createdAt) >= yearStart && Date.parse(pr.createdAt) < t);
  const yearIssues = history.issues.filter((i) => Date.parse(i.createdAt) >= yearStart && Date.parse(i.createdAt) < t);
  const closeDays = (createdAt: string, closedAt: string) => (Date.parse(closedAt) - Date.parse(createdAt)) / DAY_MS;
  const prCloseSec = mean(yearPrs.filter((pr) => before(pr.closedAt ?? pr.mergedAt, t)).map((pr) => closeDays(pr.createdAt, (pr.closedAt ?? pr.mergedAt)!) * 86_400));
  const issueCloseSec = mean(yearIssues.filter((i) => before(i.closedAt, t)).map((i) => closeDays(i.createdAt, i.closedAt!) * 86_400));
  const pastYear: EcosystemsIssueStats["pastYear"] = {
    issues: yearIssues.length,
    pullRequests: yearPrs.length,
    mergedPullRequests: yearPrs.filter((pr) => before(pr.mergedAt, t)).length,
    avgTimeToCloseIssueSec: issueCloseSec,
    avgTimeToClosePrSec: prCloseSec,
    prAuthors: new Set(yearPrs.filter((pr) => !pr.authorIsBot && pr.author).map((pr) => pr.author)).size,
    issueAuthors: new Set(yearIssues.filter((i) => !i.authorIsBot && i.author).map((i) => i.author)).size,
  };
  // Only the year before T is known, so the all-time figures repeat it.
  const issueStats: EcosystemsIssueStats = {
    issues: pastYear.issues,
    pullRequests: pastYear.pullRequests,
    mergedPullRequests: pastYear.mergedPullRequests,
    avgTimeToCloseIssueSec: pastYear.avgTimeToCloseIssueSec,
    avgTimeToClosePrSec: pastYear.avgTimeToClosePrSec,
    pastYear,
  };

  return { facts, ecosystems: current.ecosystems, issueStats, details, packages: undefined };
}
