import type { Evidence, Signals } from "@gitgoblin/core";
import { assessLicense } from "./license.ts";
import { average, clamp01, daysSince, decay, logScale } from "./math.ts";
import type { EnrichedRepo } from "./types.ts";

export interface ComputedSignals {
  signals: Signals;
  evidence: Evidence;
}

/**
 * Turns raw facts into normalized 0..1 signals plus the evidence behind them.
 * Every branch tolerates missing sources: a signal that cannot be computed is
 * left undefined rather than guessed.
 */
export function computeSignals(repo: EnrichedRepo, now: number): ComputedSignals {
  const { facts, ecosystems, packages, issueStats, details } = repo;
  const signals: Signals = {};
  const evidence: Evidence = {};

  // Activity: how recently code landed.
  const daysSincePush = daysSince(facts.pushedAt ?? ecosystems?.pushedAt, now);
  const daysSinceCommit = daysSince(details?.lastCommitAt, now);
  evidence.daysSincePush = daysSincePush;
  evidence.daysSinceCommit = daysSinceCommit;
  const recency = daysSinceCommit ?? daysSincePush;
  if (recency !== undefined) {
    const recent = decay(recency, 45);
    const pastYearPrs = issueStats?.pastYear.mergedPullRequests;
    signals.activity = pastYearPrs === undefined ? recent : 0.7 * recent + 0.3 * logScale(pastYearPrs, 100);
  }
  evidence.pullRequestsLastYear = issueStats?.pastYear.pullRequests;
  evidence.issuesLastYear = issueStats?.pastYear.issues;
  evidence.commitCount = details?.commitCount ?? ecosystems?.commitStats?.totalCommits;

  // Responsiveness: how fast issues and pull requests get closed, favouring the past year.
  if (issueStats) {
    const year = issueStats.pastYear;
    const issueSec = year.issues >= 3 ? year.avgTimeToCloseIssueSec : issueStats.avgTimeToCloseIssueSec;
    const prSec = year.pullRequests >= 3 ? year.avgTimeToClosePrSec : issueStats.avgTimeToClosePrSec;
    evidence.avgIssueCloseDays = issueSec === undefined ? undefined : issueSec / 86_400;
    evidence.avgPrCloseDays = prSec === undefined ? undefined : prSec / 86_400;
    evidence.mergedPullRequests = issueStats.mergedPullRequests;
    const timeScore = average([
      evidence.avgIssueCloseDays === undefined ? undefined : decay(evidence.avgIssueCloseDays, 14),
      evidence.avgPrCloseDays === undefined ? undefined : decay(evidence.avgPrCloseDays, 10),
    ]);
    const mergeRatio = year.pullRequests >= 3 ? clamp01(year.mergedPullRequests / year.pullRequests) : undefined;
    const combined = timeScore !== undefined && mergeRatio !== undefined ? 0.6 * timeScore + 0.4 * mergeRatio : (timeScore ?? mergeRatio);
    if (combined !== undefined) signals.responsiveness = combined;
  } else if (details?.lastMergedAt) {
    // Weak proxy: a recently merged pull request means someone is reviewing.
    const sinceMerge = daysSince(details.lastMergedAt, now) ?? 365;
    evidence.mergedPullRequests = details.mergedPullRequests;
    signals.responsiveness = 0.7 * decay(sinceMerge, 30);
  }

  // Acceptance: the share of pull requests that get merged. It is the strongest predictor of a
  // newcomer's pull request being merged that the backtest in packages/eval found, and stars
  // predict the opposite. Small samples stay unknown rather than reading 1 of 1 as 100%.
  if (issueStats) {
    const year = issueStats.pastYear;
    evidence.mergedPullRequestsLastYear = year.mergedPullRequests;
    if (year.pullRequests >= 5) signals.acceptance = clamp01(year.mergedPullRequests / year.pullRequests);
    else if (issueStats.pullRequests >= 10) signals.acceptance = clamp01(issueStats.mergedPullRequests / issueStats.pullRequests);
  }

  // Bus factor: how spread out the work is.
  const stats = ecosystems?.commitStats;
  if (stats && stats.totalCommitters > 0) {
    evidence.contributors = stats.totalCommitters;
    if (stats.dds !== undefined) evidence.topContributorShare = clamp01(1 - stats.dds);
    // ecosyste.ms has reported dds above 1; it is a share, so keep it one.
    const spread = clamp01(stats.dds ?? 0);
    signals.busFactor = 0.6 * spread + 0.4 * logScale(stats.totalCommitters, 50);
  } else if (details) {
    evidence.contributors = details.mentionableUsers;
    signals.busFactor = 0.7 * logScale(details.mentionableUsers, 50);
  }

  // Newcomer friendliness: the welcome mat.
  const files = ecosystems?.files ?? {};
  const hasContributing = details?.hasContributing ?? (ecosystems ? "contributing" in files : undefined);
  const hasCodeOfConduct = details?.hasCodeOfConduct ?? (ecosystems ? "code_of_conduct" in files : undefined);
  const hasIssueTemplates = details ? details.issueTemplates > 0 : undefined;
  evidence.hasContributing = hasContributing;
  evidence.hasCodeOfConduct = hasCodeOfConduct;
  evidence.hasIssueTemplates = hasIssueTemplates;
  evidence.goodFirstIssues = details?.starterIssues;
  evidence.openIssues = details?.openIssues ?? facts.openIssues;
  if (hasContributing !== undefined) {
    if (details && !details.hasIssuesEnabled) {
      signals.newcomerFriendliness = 0;
    } else {
      let score = 0;
      let known = 0.45;
      if (hasContributing) score += 0.3;
      if (hasCodeOfConduct) score += 0.15;
      if (hasIssueTemplates !== undefined) {
        known += 0.15;
        if (hasIssueTemplates) score += 0.15;
      }
      if (details) {
        known += 0.3;
        score += 0.3 * clamp01(details.starterIssues / 5);
      }
      if (issueStats) {
        known += 0.1;
        score += 0.1 * logScale(issueStats.pastYear.prAuthors, 30);
      }
      signals.newcomerFriendliness = clamp01(score / known);
    }
  }

  // Docs: can a stranger figure out what this is?
  const hasReadme = ecosystems ? "readme" in files : undefined;
  const hasChangelog = ecosystems ? "changelog" in files : undefined;
  evidence.hasReadme = hasReadme;
  evidence.hasChangelog = hasChangelog;
  evidence.hasFunding = ecosystems?.hasFunding;
  {
    let score = 0;
    let known = 0.35;
    if (facts.description && facts.description.trim().length >= 20) score += 0.15;
    if (facts.homepage) score += 0.2;
    if (hasReadme !== undefined) {
      known += 0.5;
      if (hasReadme) score += 0.5;
    }
    if (hasChangelog !== undefined) {
      known += 0.15;
      if (hasChangelog) score += 0.15;
    }
    signals.docs = hasReadme === undefined ? Math.min(0.7, score / known) : clamp01(score / known);
  }

  // Maturity: age and releases.
  const ageDays = daysSince(facts.createdAt ?? ecosystems?.createdAt, now);
  evidence.ageDays = ageDays;
  const releases = details?.releases ?? ecosystems?.tagsCount;
  evidence.releases = releases;
  if (ageDays !== undefined) {
    const ageScore = clamp01(ageDays / (3 * 365));
    signals.maturity = releases === undefined ? ageScore : 0.6 * ageScore + 0.4 * logScale(releases, 30);
  }

  // Popularity and momentum.
  signals.popularity = logScale(facts.stars, 50_000);
  if (ageDays !== undefined) {
    const starsPerMonth = facts.stars / Math.max(1, ageDays / 30);
    evidence.starsPerMonth = starsPerMonth;
    signals.momentum = logScale(starsPerMonth, 500);
  }

  // Usage: are other projects depending on it?
  if (packages && packages.length > 0) {
    // Most-used first, so the package we name in explanations is the one that matters.
    const ranked = [...packages].sort((a, b) => b.dependentRepos - a.dependentRepos || b.downloads - a.downloads);
    const dependentRepos = ranked[0]?.dependentRepos ?? 0;
    const dependentPackages = Math.max(...ranked.map((p) => p.dependentPackages));
    const downloads = Math.max(...ranked.map((p) => (p.downloadsPeriod === "last-month" ? p.downloads : 0)));
    evidence.dependentRepos = dependentRepos;
    evidence.dependentPackages = dependentPackages;
    evidence.downloadsLastMonth = downloads > 0 ? downloads : undefined;
    evidence.packageNames = [...new Set(ranked.map((p) => `${p.ecosystem}:${p.name}`))].slice(0, 5);
    const packageScore =
      0.5 * logScale(dependentRepos, 100_000) + 0.3 * logScale(dependentPackages, 1_000) + 0.2 * logScale(downloads, 10_000_000);
    signals.usage = Math.max(packageScore, 0.6 * logScale(facts.forks, 5_000));
  } else {
    signals.usage = 0.6 * logScale(facts.forks, 5_000);
  }
  evidence.scorecardScore = ecosystems?.scorecardScore;

  // License.
  signals.license = assessLicense(facts.license ?? details?.license ?? ecosystems?.license).score;

  // Every signal is a 0..1 quality whatever a source sends: a non-number is unknown, anything else is clamped.
  for (const name of Object.keys(signals) as (keyof Signals)[]) {
    const value = signals[name];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) delete signals[name];
    else signals[name] = clamp01(value);
  }

  return { signals, evidence };
}
