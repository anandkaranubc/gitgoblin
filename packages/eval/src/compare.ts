/**
 * Paired comparison of two scorings of the same repositories: the stored scores (the discovery
 * code that fetched the dataset) against a re-score with the code checked out now. Both outcomes
 * are compared: graded newcomer success (nDCG@k, macro over languages) and a newcomer's odds
 * (Spearman with the newcomer merge rate among repositories with three or more decided).
 */
import { type BacktestDataset, covered, rescore, toCandidate } from "./discovery-backtest.ts";
import { bootstrap, ndcgAtK, spearman } from "./metrics.ts";
import { rankCandidates } from "./baselines.ts";

export interface Comparison {
  repositories: number;
  oddsPool: number;
  ndcg: { before: number; after: number; delta: { estimate: number; lower: number; upper: number } };
  odds: { before: number; after: number; delta: { estimate: number; lower: number; upper: number } };
}

function macroNdcg(rows: BacktestDataset["rows"], k: number): number {
  const byLanguage = new Map<string, BacktestDataset["rows"]>();
  for (const r of rows) byLanguage.set(r.language, [...(byLanguage.get(r.language) ?? []), r]);
  const values = [...byLanguage.values()].map((pool) => ndcgAtK(rankCandidates(pool.map(toCandidate), "gitgoblin").map((c) => c.grade), k));
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function oddsCorrelation(rows: BacktestDataset["rows"]): number {
  const decided = rows.filter((r) => !r.excluded && r.outcome.merged + r.outcome.closedUnmerged >= 3);
  return spearman(decided.map((r) => r.score), decided.map((r) => r.outcome.mergeRate ?? 0)) ?? 0;
}

export function compareRescore(dataset: BacktestDataset, options: { k?: number | undefined; iterations?: number | undefined; seed?: number | undefined } = {}): Comparison {
  const k = options.k ?? 10;
  const before = dataset.rows.filter((r) => covered(r, dataset.asOf));
  const after = rescore({ ...dataset, rows: before }).rows;
  const iter = { iterations: options.iterations ?? 2000, seed: options.seed ?? 1 };
  const pick = <T>(xs: T[], idx: number[]) => idx.map((i) => xs[i]!);
  const ndcg = bootstrap(before.length, (idx) => macroNdcg(pick(after, idx), k) - macroNdcg(pick(before, idx), k), iter);
  const odds = bootstrap(before.length, (idx) => oddsCorrelation(pick(after, idx)) - oddsCorrelation(pick(before, idx)), iter);
  return {
    repositories: before.length,
    oddsPool: before.filter((r) => !r.excluded && r.outcome.merged + r.outcome.closedUnmerged >= 3).length,
    ndcg: { before: macroNdcg(before, k), after: macroNdcg(after, k), delta: { estimate: ndcg.estimate, lower: ndcg.lower, upper: ndcg.upper } },
    odds: { before: oddsCorrelation(before), after: oddsCorrelation(after), delta: { estimate: odds.estimate, lower: odds.lower, upper: odds.upper } },
  };
}
