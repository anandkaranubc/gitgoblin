import type { Evidence, Goal, Reason, SignalName, Signals } from "@gitgoblin/core";
import { clamp01, formatCount, logScale } from "./math.ts";
import type { EnrichedRepo } from "./types.ts";

export interface GoalProfile {
  /** Positive weights reward a high signal; negative weights reward a low one. */
  weights: Partial<Record<SignalName, number>>;
  /** Which optional lookups are worth their cost for this goal. */
  enrich: { packages: boolean; issues: boolean };
  /** Returns a short reason when the repository should not appear for this goal. */
  exclude(repo: EnrichedRepo, evidence: Evidence): string | undefined;
  /** Extra score adjustments, each explained. */
  bonuses(repo: EnrichedRepo, signals: Signals, evidence: Evidence): Reason[];
}

const YEAR = 365;

export const GOAL_PROFILES: Record<Goal, GoalProfile> = {
  contribute: {
    enrich: { packages: false, issues: true },
    weights: {
      newcomerFriendliness: 3,
      responsiveness: 3,
      activity: 2.5,
      docs: 1.5,
      busFactor: 1,
      license: 1,
      popularity: 0.5,
    },
    exclude: (repo, evidence) => {
      if (repo.facts.archived) return "archived";
      if (repo.details && !repo.details.hasIssuesEnabled) return "issues are disabled";
      if ((evidence.daysSincePush ?? 0) > 180) return "no pushes in the last 6 months";
      return undefined;
    },
    bonuses: (_repo, _signals, evidence) => {
      const reasons: Reason[] = [];
      if (evidence.goodFirstIssues) {
        reasons.push({
          signal: "newcomerFriendliness",
          weight: 0.1 * clamp01(evidence.goodFirstIssues / 5),
          detail: `${evidence.goodFirstIssues} open starter issue${evidence.goodFirstIssues === 1 ? "" : "s"}`,
        });
      }
      return reasons;
    },
  },

  learn: {
    enrich: { packages: false, issues: false },
    weights: {
      docs: 3,
      maturity: 2,
      popularity: 1.5,
      activity: 1,
      busFactor: 1,
      license: 1,
    },
    exclude: (repo) => (repo.facts.archived ? "archived" : undefined),
    bonuses: () => [],
  },

  adopt: {
    enrich: { packages: true, issues: true },
    weights: {
      usage: 3,
      activity: 2,
      responsiveness: 2,
      maturity: 2,
      busFactor: 2,
      license: 2,
      docs: 1.5,
      popularity: 1,
    },
    exclude: (repo, evidence) => {
      if (repo.facts.archived) return "archived";
      if ((evidence.daysSincePush ?? 0) > 1.5 * YEAR) return "no pushes in the last 18 months";
      if ((repo.facts.license ?? repo.details?.license) === undefined) return "no license";
      return undefined;
    },
    bonuses: () => [],
  },

  revive: {
    enrich: { packages: true, issues: false },
    weights: {
      usage: 3,
      activity: -2.5,
      license: 2,
      docs: 1,
      maturity: 1,
      popularity: 0.5,
    },
    exclude: (repo, evidence) => {
      if (!repo.facts.archived && (evidence.daysSincePush ?? Number.POSITIVE_INFINITY) < YEAR) return "still active";
      if ((repo.facts.license ?? repo.details?.license) === undefined) return "no license, cannot be forked legally";
      return undefined;
    },
    bonuses: (repo, _signals, evidence) => {
      const reasons: Reason[] = [];
      const open = evidence.openIssues ?? 0;
      if (open >= 5) {
        reasons.push({ signal: "usage", weight: 0.06 * logScale(open, 200), detail: `${formatCount(open)} open issues show unmet demand` });
      }
      if (repo.facts.forks >= 10 && repo.facts.forks >= repo.facts.stars * 0.15) {
        reasons.push({ signal: "usage", weight: 0.03, detail: `${formatCount(repo.facts.forks)} forks relative to stars` });
      }
      if (repo.facts.archived) reasons.push({ signal: "filter", weight: -0.05, detail: "archived: revival means forking" });
      return reasons;
    },
  },

  explore: {
    enrich: { packages: false, issues: false },
    weights: {
      popularity: -3,
      activity: 2,
      docs: 1.5,
      momentum: 1,
      busFactor: 1,
      maturity: 0.5,
      license: 0.5,
    },
    exclude: (repo) => (repo.facts.archived ? "archived" : undefined),
    bonuses: () => [],
  },
};
