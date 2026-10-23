/**
 * The rankings compared in the discovery backtest: gitgoblin's score and the
 * conventional alternatives, all applied to the same candidates after the
 * same exclusions.
 */
import { seededRandom } from "./metrics.ts";

export interface Candidate {
  id: string;
  language: string;
  /** Discovery's score as of T. */
  score: number;
  /** Set when discovery's goal profile excluded the repository at T. */
  excluded?: string | undefined;
  stars: number;
  starterIssuesAtT: number;
  daysSinceCommitAtT?: number | undefined;
  /** Newcomer outcomes in the year before T: the behavioural signal discovery lacks. */
  priorNewcomerMergeRate?: number | undefined;
  priorNewcomerMerged: number;
  /** Outcome in the window after T. */
  grade: number;
  merged: number;
}

export const RANKINGS = ["gitgoblin", "stars", "starterIssues", "recency", "priorNewcomers", "random"] as const;
export type Ranking = (typeof RANKINGS)[number];

export const RANKING_LABELS: Record<Ranking, string> = {
  gitgoblin: "gitgoblin contribute score",
  stars: "most stars",
  starterIssues: "most open starter issues",
  recency: "most recent commit",
  priorNewcomers: "newcomer merge rate in the prior year",
  random: "random",
};

/** The number a ranking sorts by; higher is better, undefined sorts last. */
export function rankingKey(ranking: Ranking, c: Candidate): number | undefined {
  switch (ranking) {
    case "gitgoblin":
      return c.score;
    case "stars":
      return c.stars;
    case "starterIssues":
      return c.starterIssuesAtT;
    case "recency":
      return c.daysSinceCommitAtT === undefined ? undefined : -c.daysSinceCommitAtT;
    case "priorNewcomers":
      // Rate alone is noisy at one merged pull request; weight it by how much was merged.
      return c.priorNewcomerMergeRate === undefined ? undefined : c.priorNewcomerMergeRate * Math.log1p(c.priorNewcomerMerged);
    case "random":
      return 0;
  }
}

export function rankCandidates(pool: Candidate[], ranking: Ranking, seed = 1): Candidate[] {
  const eligible = pool.filter((c) => !c.excluded);
  if (ranking === "random") {
    const random = seededRandom(seed);
    return eligible
      .map((c) => ({ c, r: random() }))
      .sort((a, b) => a.r - b.r || a.c.id.localeCompare(b.c.id))
      .map((x) => x.c);
  }
  return [...eligible].sort((a, b) => {
    const ka = rankingKey(ranking, a);
    const kb = rankingKey(ranking, b);
    if (ka === undefined && kb === undefined) return a.id.localeCompare(b.id);
    if (ka === undefined) return 1;
    if (kb === undefined) return -1;
    return kb - ka || a.id.localeCompare(b.id);
  });
}
