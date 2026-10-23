import type { RepoFacts, RepoRef } from "./repo.ts";

/**
 * What the user is trying to do. Discovery ranks the same repositories very
 * differently depending on the goal: an abandoned-but-depended-on library is a
 * poor "adopt" result and a great "revive" result.
 */
export const GOALS = ["contribute", "learn", "adopt", "revive", "explore"] as const;
export type Goal = (typeof GOALS)[number];

export const GOAL_DESCRIPTIONS: Record<Goal, string> = {
  contribute: "Active, welcoming projects where a newcomer can land a change",
  learn: "Well-documented, mature codebases worth reading",
  adopt: "Maintained, widely used libraries and tools you can depend on",
  revive: "Valuable projects that have gone quiet and could use a maintainer or fork",
  explore: "Interesting projects most people have not seen yet",
};

export function isGoal(value: string): value is Goal {
  return (GOALS as readonly string[]).includes(value);
}

/**
 * Normalized signals, each in [0, 1] where higher means "more of the named
 * quality". A missing signal means "unknown", never "zero".
 */
export const SIGNAL_NAMES = [
  "activity",
  "responsiveness",
  "busFactor",
  "newcomerFriendliness",
  "docs",
  "maturity",
  "popularity",
  "usage",
  "momentum",
  "license",
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];
export type Signals = Partial<Record<SignalName, number>>;

export const SIGNAL_DESCRIPTIONS: Record<SignalName, string> = {
  activity: "Recent commits and pushes",
  responsiveness: "How quickly maintainers close issues and pull requests",
  busFactor: "How evenly work is spread across contributors",
  newcomerFriendliness: "Contributing guide, code of conduct, templates and open starter issues",
  docs: "README, homepage and changelog",
  maturity: "Age and release history",
  popularity: "Stars, log-scaled",
  usage: "Packages, dependents and downloads from registries",
  momentum: "Growth relative to age",
  license: "Presence and openness of the license",
};

/** Raw facts behind the signals, kept so results can be explained and audited. */
export interface Evidence {
  ageDays?: number | undefined;
  daysSincePush?: number | undefined;
  daysSinceCommit?: number | undefined;
  commitCount?: number | undefined;
  contributors?: number | undefined;
  /** Share of commits by the single most active committer, 0..1. */
  topContributorShare?: number | undefined;
  openIssues?: number | undefined;
  goodFirstIssues?: number | undefined;
  avgIssueCloseDays?: number | undefined;
  avgPrCloseDays?: number | undefined;
  mergedPullRequests?: number | undefined;
  pullRequestsLastYear?: number | undefined;
  issuesLastYear?: number | undefined;
  hasContributing?: boolean | undefined;
  hasCodeOfConduct?: boolean | undefined;
  hasIssueTemplates?: boolean | undefined;
  hasReadme?: boolean | undefined;
  hasChangelog?: boolean | undefined;
  hasFunding?: boolean | undefined;
  releases?: number | undefined;
  dependentRepos?: number | undefined;
  dependentPackages?: number | undefined;
  downloadsLastMonth?: number | undefined;
  packageNames?: string[] | undefined;
  starsPerMonth?: number | undefined;
  scorecardScore?: number | undefined;
}

/** Why a repository scored the way it did. Positive weight helped, negative hurt. */
export interface Reason {
  signal: SignalName | "filter" | "jitter";
  weight: number;
  detail: string;
}

/** An open issue surfaced for the contribute goal. Raw and unvalidated. */
export interface IssueCandidate {
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
}

export interface DiscoveryFilters {
  languages?: string[] | undefined;
  topics?: string[] | undefined;
  keywords?: string[] | undefined;
  minStars?: number | undefined;
  maxStars?: number | undefined;
  pushedWithinDays?: number | undefined;
  createdWithinDays?: number | undefined;
  /** SPDX identifiers. */
  licenses?: string[] | undefined;
  includeArchived?: boolean | undefined;
  includeForks?: boolean | undefined;
  excludeOwners?: string[] | undefined;
}

export interface DiscoveryQuery {
  goal: Goal;
  filters?: DiscoveryFilters | undefined;
  /** Find repositories related to this one (shared topics, language, ecosystem). */
  seed?: RepoRef | undefined;
  /** Maximum results to return. */
  limit?: number | undefined;
  /** Makes the explore goal reproducible. */
  randomSeed?: number | undefined;
}

export interface DiscoveryResult {
  repo: RepoFacts;
  goal: Goal;
  /** 0..1, comparable only within the same goal. */
  score: number;
  reasons: Reason[];
  signals: Signals;
  evidence: Evidence;
  issues?: IssueCandidate[] | undefined;
}

/** The contract other components (CLI, web, engine) depend on. */
export interface Discoverer {
  discover(query: DiscoveryQuery): Promise<DiscoveryResult[]>;
}
