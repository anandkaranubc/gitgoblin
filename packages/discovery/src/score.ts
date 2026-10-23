import type { Evidence, Goal, Reason, SignalName, Signals } from "@gitgoblin/core";
import { SIGNAL_NAMES } from "@gitgoblin/core";
import { assessLicense } from "./license.ts";
import { clamp01, formatCount, formatDays } from "./math.ts";
import { GOAL_PROFILES } from "./profiles.ts";
import { computeSignals } from "./signals.ts";
import type { EnrichedRepo } from "./types.ts";

export interface ScoredRepo {
  score: number;
  reasons: Reason[];
  signals: Signals;
  evidence: Evidence;
  /** Set when the goal profile rejected the repository. */
  excluded?: string | undefined;
}

export interface ScoreOptions {
  now: number;
  /** Random nudge in [-1, 1] for the explore goal; scaled internally. */
  jitter?: number | undefined;
}

/**
 * Scores one repository for a goal. The score is a weighted mean of the known
 * signals, discounted a little when many signals are unknown, plus explained
 * bonuses. Reasons report each signal's push away from neutral (0.5).
 */
export function scoreRepo(repo: EnrichedRepo, goal: Goal, options: ScoreOptions): ScoredRepo {
  const profile = GOAL_PROFILES[goal];
  const { signals, evidence } = computeSignals(repo, options.now);
  const excluded = profile.exclude(repo, evidence);
  if (excluded) {
    return { score: 0, reasons: [{ signal: "filter", weight: -1, detail: excluded }], signals, evidence, excluded };
  }

  let weighted = 0;
  let knownWeight = 0;
  let totalWeight = 0;
  const contributions: Reason[] = [];
  for (const name of SIGNAL_NAMES) {
    const value = signals[name];
    const weight = profile.weights[name] ?? 0;
    totalWeight += Math.abs(weight);
    if (value === undefined) continue;
    knownWeight += Math.abs(weight);
    const oriented = weight > 0 ? value : weight < 0 ? 1 - value : value;
    weighted += Math.abs(weight) * oriented;
    // Unweighted signals get a zero-weight reason so `explain` can still show their evidence.
    contributions.push({ signal: name, weight: Math.abs(weight) * (oriented - 0.5), detail: describe(name, repo, signals, evidence, weight < 0) });
  }

  const coverage = totalWeight > 0 ? knownWeight / totalWeight : 0;
  const base = knownWeight > 0 ? weighted / knownWeight : 0;
  const bonuses = profile.bonuses(repo, signals, evidence);
  let score = base * (0.75 + 0.25 * coverage) + bonuses.reduce((sum, b) => sum + b.weight, 0);

  const reasons = contributions
    .map((r) => ({ ...r, weight: knownWeight > 0 ? r.weight / knownWeight : 0 }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .concat(bonuses);

  if (goal === "explore" && options.jitter !== undefined) {
    const nudge = 0.08 * options.jitter;
    score += nudge;
    reasons.push({ signal: "jitter", weight: nudge, detail: "random nudge for serendipity" });
  }

  return { score: round(clamp01(score)), reasons: reasons.map((r) => ({ ...r, weight: round(r.weight) })), signals, evidence };
}

function round(value: number): number {
  // `|| 0` turns -0 (an unweighted signal below neutral) into 0.
  return Math.round(value * 1000) / 1000 || 0;
}

function describe(name: SignalName, repo: EnrichedRepo, _signals: Signals, evidence: Evidence, inverted: boolean): string {
  const { facts } = repo;
  switch (name) {
    case "activity": {
      const days = evidence.daysSinceCommit ?? evidence.daysSincePush;
      const when = days === undefined ? "unknown" : formatDays(days);
      const prs = evidence.pullRequestsLastYear;
      const extra = prs !== undefined && prs > 0 ? `, ${formatCount(prs)} pull requests in the past year` : "";
      return inverted ? `last change ${when}${extra}` : `last change ${when}${extra}`;
    }
    case "responsiveness": {
      const parts: string[] = [];
      if (evidence.avgIssueCloseDays !== undefined) parts.push(`issues close in ~${formatSpan(evidence.avgIssueCloseDays)}`);
      if (evidence.avgPrCloseDays !== undefined) parts.push(`pull requests in ~${formatSpan(evidence.avgPrCloseDays)}`);
      if (parts.length === 0 && evidence.mergedPullRequests !== undefined) parts.push(`${formatCount(evidence.mergedPullRequests)} merged pull requests`);
      return parts.join(", ") || "maintainer responsiveness";
    }
    case "acceptance": {
      const year = evidence.pullRequestsLastYear ?? 0;
      const merged = evidence.mergedPullRequestsLastYear ?? 0;
      if (year >= 5) return `merged ${Math.round((merged / year) * 100)}% of pull requests in the past year (${formatCount(merged)} of ${formatCount(year)})`;
      return "share of pull requests merged, all time";
    }
    case "busFactor": {
      const people = evidence.contributors ?? 0;
      const share = evidence.topContributorShare;
      const shareText = share === undefined ? "" : `, top committer wrote ${Math.round(share * 100)}%`;
      return `${formatCount(people)} contributor${people === 1 ? "" : "s"}${shareText}`;
    }
    case "newcomerFriendliness": {
      if (repo.details && !repo.details.hasIssuesEnabled) return "issues are disabled";
      const has: string[] = [];
      const missing: string[] = [];
      (evidence.hasContributing ? has : missing).push("CONTRIBUTING guide");
      (evidence.hasCodeOfConduct ? has : missing).push("code of conduct");
      if (evidence.hasIssueTemplates !== undefined) (evidence.hasIssueTemplates ? has : missing).push("issue templates");
      if (has.length === 0) return `no ${missing.join(", ")}`;
      return missing.length > 0 ? `${has.join(", ")}; no ${missing.join(", ")}` : has.join(", ");
    }
    case "docs": {
      const has: string[] = [];
      const missing: string[] = [];
      (evidence.hasReadme ? has : missing).push("README");
      (facts.description && facts.description.length >= 20 ? has : missing).push("description");
      (facts.homepage ? has : missing).push("homepage");
      (evidence.hasChangelog ? has : missing).push("changelog");
      if (has.length === 0) return "no documentation found";
      return missing.length > 0 ? `${has.join(", ")}; no ${missing.join(", ")}` : has.join(", ");
    }
    case "maturity": {
      const age = evidence.ageDays === undefined ? "age unknown" : `created ${formatDays(evidence.ageDays)}`;
      const releases = evidence.releases ? `, ${formatCount(evidence.releases)} releases` : "";
      return `${age}${releases}`;
    }
    case "popularity":
      return `${formatCount(facts.stars)} stars${inverted ? " (less-known projects rank higher here)" : ""}`;
    case "usage": {
      const dependents = evidence.dependentRepos ?? 0;
      const via = evidence.packageNames?.[0] ? ` via ${evidence.packageNames[0]}` : "";
      if (dependents >= Math.max(1, facts.forks)) return `used by ${formatCount(dependents)} repositories${via}`;
      if (evidence.downloadsLastMonth && evidence.downloadsLastMonth >= 10_000) return `${formatCount(evidence.downloadsLastMonth)} downloads last month${via}`;
      const packages = dependents > 0 ? `, ${formatCount(dependents)} dependents${via}` : evidence.packageNames ? "" : ", no published packages found";
      return `${formatCount(facts.forks)} forks${packages}`;
    }
    case "momentum": {
      const rate = evidence.starsPerMonth ?? 0;
      return rate >= 1 ? `~${formatCount(rate)} stars per month since creation` : "slow star growth";
    }
    case "license":
      return assessLicense(facts.license ?? repo.details?.license ?? repo.ecosystems?.license).label;
  }
}

function formatSpan(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 60) return `${Math.round(days)} days`;
  return `${Math.round(days / 30)} months`;
}
