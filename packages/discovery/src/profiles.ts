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
  /**
   * Scales the final score by a signal that should multiply the others rather than average with
   * them: a project that never merges outside work is a poor place to contribute however active it is.
   */
  scale?: { signal: SignalName; factor(signals: Signals): number } | undefined;
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
    // A newcomer's pull request is merged more often where many pull requests are, and stars point
    // the other way; a project merging none keeps half its score, unknown keeps three quarters.
    // packages/eval/docs/design.md records the backtest behind the numbers.
    scale: { signal: "acceptance", factor: (signals) => (signals.acceptance === undefined ? 0.75 : 0.5 + 0.5 * signals.acceptance) },
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
