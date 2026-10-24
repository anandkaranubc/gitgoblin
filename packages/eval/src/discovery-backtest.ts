/**
 * E1: does discovery's `contribute` ranking, computed from what was knowable
 * at T, predict where newcomers got pull requests merged in the window after
 * T, better than stars, starter-issue counts, recency or chance?
 */
import { type RepoFacts, repoId } from "@gitgoblin/core";
import { computeSignals, type EnrichedRepo, scoreRepo } from "@gitgoblin/discovery";
import { createSources, type GitHubRepoDetails, STARTER_ISSUE_LABELS } from "@gitgoblin/sources";
import { enrichedAsOf } from "./asof.ts";
import { type Candidate, RANKINGS, type Ranking, rankCandidates, rankingKey } from "./baselines.ts";
import { fetchHistory, fetchLabeledIssues, graphqlReset, withRateLimitRetry } from "./github/history.ts";
import type { Example } from "./learn.ts";
import { auc, bootstrap, ndcgAtK, precisionAtK, spearman } from "./metrics.ts";
import { gradeOutcome, gradePeople, type NewcomerOutcome, newcomerOutcomes, type OutsiderOutcome, outsiderOutcomes, type TrackerStats, trackerStats } from "./outcomes.ts";
import { type PoolMember, poolQueries, samplePool } from "./pool.ts";

const DAY_MS = 86_400_000;

export interface BacktestRow {
  id: string;
  language: string;
  /** Star-band slices that found this repository, e.g. "200-999 stars". */
  slices: string[];
  /** Discovery's input as of T (current-only facts flagged in the design note). */
  enriched: EnrichedRepo;
  score: number;
  excluded?: string | undefined;
  reasons: { signal: string; weight: number; detail: string }[];
  starsNow: number;
  starterIssuesAtT: number;
  daysSinceCommitAtT?: number | undefined;
  outcome: NewcomerOutcome;
  grade: number;
  /** The same measurement over the year before T. */
  prior: NewcomerOutcome;
  /** Every outside pull request in the year before T: the query-time version of `prior`. Absent in datasets fetched before it existed. */
  priorOutsider?: OutsiderOutcome | undefined;
  tracker: TrackerStats;
  historyStart?: string | undefined;
  prsTruncated: boolean;
  issuesTruncated: boolean;
  prCount: number;
  issueCount: number;
  /** The outcome and past-year statistics came from GitHub search because the history could not be paged back to T (see busy.ts). */
  completedBySearch?: boolean | undefined;
}

export interface BacktestDataset {
  experiment: "discovery-backtest";
  asOf: string;
  windowDays: number;
  fetchedAt: string;
  languages: string[];
  perLanguage: number;
  seed: number;
  /** The sampled candidates per language, so a run can be resumed or repeated without searching again. */
  pool: Record<string, PoolMember[]>;
  /** Candidates whose fetch failed, with the reason. */
  skipped: { id: string; language: string; reason: string }[];
  rows: BacktestRow[];
}

export interface FetchOptions {
  asOf: string;
  windowDays: number;
  languages: string[];
  perLanguage: number;
  seed?: number | undefined;
  cachePath?: string | undefined;
  /** Reuse this dataset's pool and rows; only missing or skipped candidates are fetched. */
  resume?: BacktestDataset | undefined;
  /** With `resume`: keep its pool but recompute every row (history comes from the cache, so this is cheap). */
  recompute?: boolean | undefined;
  /** Repositories fetched at once. Default 3. */
  concurrency?: number | undefined;
  /** Pages of 100 pull requests per repository. Default 6; older dates need more to reach back a year before T. */
  maxPrPages?: number | undefined;
  /** Called with the dataset so far after every language and every 25 repositories, so a crash loses little. */
  checkpoint?: ((dataset: BacktestDataset) => Promise<void>) | undefined;
  log?: ((message: string) => void) | undefined;
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

export async function fetchDataset(options: FetchOptions): Promise<BacktestDataset> {
  const log = options.log ?? (() => {});
  const seed = options.seed ?? 1;
  const asOfMs = Date.parse(options.asOf);
  const asOf = new Date(asOfMs).toISOString();
  const since = new Date(asOfMs - 365 * DAY_MS).toISOString();
  const windowEnd = new Date(asOfMs + options.windowDays * DAY_MS).toISOString();
  if (Date.parse(windowEnd) > Date.now()) throw new Error(`window ends ${windowEnd}, in the future; pick an earlier --as-of or a shorter --window`);

  const sources = await createSources({ cachePath: options.cachePath });
  if (!sources.github.authenticated) throw new Error("a GitHub token is required (GITHUB_TOKEN or gh auth login)");
  const rows: BacktestRow[] = options.recompute ? [] : [...(options.resume?.rows ?? [])];
  const done = new Set(rows.map((r) => r.id));
  const poolByLanguage: Record<string, PoolMember[]> = {};
  const skipped: BacktestDataset["skipped"] = [];
  try {
    for (const language of options.languages) {
      let pool = options.resume?.pool[language];
      // An empty saved pool means the searches failed last time; search again.
      if (!pool?.length) {
        const found: { facts: RepoFacts; slice: string }[] = [];
        for (const query of poolQueries(language, asOf)) {
          try {
            const result = await sources.github.searchRepositories(query.q, { sort: query.sort, order: "desc", perPage: 50 });
            log(`${language}: ${query.label}: ${result.items.length} of ${result.total}`);
            found.push(...result.items.map((facts) => ({ facts, slice: query.label })));
          } catch (error) {
            log(`${language}: ${query.label} failed: ${(error as Error).message}`);
          }
        }
        pool = samplePool(found, options.perLanguage, seed);
        log(`${language}: ${pool.length} candidates from ${found.length} search results`);
      }
      poolByLanguage[language] = pool;
      const todo = pool.filter((m) => !done.has(repoId(m.facts)));
      const details = await withRateLimitRetry(() => sources.github.repoDetails(todo.map((m) => m.facts)), log, graphqlReset(sources.github)).catch((error: unknown) => {
        log(`${language}: repository details unavailable: ${(error as Error).message.split("\n")[0]}`);
        return new Map<string, GitHubRepoDetails>();
      });
      let fetched = 0;
      const snapshot = (): BacktestDataset => ({ experiment: "discovery-backtest", asOf, windowDays: options.windowDays, fetchedAt: new Date().toISOString(), languages: options.languages, perLanguage: options.perLanguage, seed, pool: poolByLanguage, skipped, rows: [...rows].sort((a, b) => a.language.localeCompare(b.language) || a.id.localeCompare(b.id)) });
      await eachLimit(todo, options.concurrency ?? 3, async ({ facts, slices }) => {
        const id = repoId(facts);
        try {
          const [ecosystems, history] = await Promise.all([
            sources.ecosystems.lookupRepository(facts).catch(() => undefined),
            fetchHistory(sources.github, facts.owner, facts.name, { since, asOf, maxPrPages: options.maxPrPages, log: (m) => log(`${id}: ${m}`) }),
          ]);
          // The issue history only reaches a year back; starter issues opened earlier and still open at T come from a labelled-issues query.
          const labelled = await fetchLabeledIssues(sources.github, facts.owner, facts.name, STARTER_ISSUE_LABELS, 3).catch(() => []);
          const known = new Set(history.issues.map((i) => i.number));
          const issues = [...history.issues, ...labelled.filter((i) => !known.has(i.number))];
          const enriched = enrichedAsOf({ facts, ecosystems, details: details.get(id) }, { ...history, issues }, asOf, STARTER_ISSUE_LABELS);
          const scored = scoreRepo(enriched, "contribute", { now: asOfMs });
          const historyStart = history.historyStart ?? asOf;
          const outcome = newcomerOutcomes(history.prs, { start: asOf, end: windowEnd }, historyStart);
          const prior = newcomerOutcomes(history.prs, { start: since, end: asOf }, historyStart);
          const lastCommit = enriched.details?.lastCommitAt ?? enriched.facts.pushedAt;
          rows.push({
            id,
            language,
            slices,
            enriched,
            score: scored.score,
            excluded: scored.excluded,
            reasons: scored.reasons.slice(0, 4),
            starsNow: facts.stars,
            starterIssuesAtT: enriched.details?.starterIssues ?? 0,
            daysSinceCommitAtT: lastCommit ? (asOfMs - Date.parse(lastCommit)) / DAY_MS : undefined,
            outcome,
            grade: gradeOutcome(outcome),
            prior,
            priorOutsider: outsiderOutcomes(history.prs, { start: since, end: asOf }),
            tracker: trackerStats(history.prs, history.issues, { start: since, end: asOf }),
            historyStart: history.historyStart,
            prsTruncated: history.prsTruncated,
            issuesTruncated: history.issuesTruncated,
            prCount: history.prs.length,
            issueCount: history.issues.length,
          });
          log(`${id}: score ${scored.score}${scored.excluded ? ` (excluded: ${scored.excluded})` : ""}, grade ${gradeOutcome(outcome)}, ${outcome.merged}/${outcome.pullRequests} newcomer PRs merged`);
        } catch (error) {
          const reason = (error as Error).message.split("\n")[0] ?? "unknown";
          skipped.push({ id, language, reason });
          log(`${id}: skipped: ${reason}`);
        }
        if (++fetched % 25 === 0) await options.checkpoint?.(snapshot());
      });
      await options.checkpoint?.(snapshot());
    }
  } finally {
    sources.close();
  }
  const final: BacktestDataset = { experiment: "discovery-backtest", asOf, windowDays: options.windowDays, fetchedAt: new Date().toISOString(), languages: options.languages, perLanguage: options.perLanguage, seed, pool: poolByLanguage, skipped, rows: [...rows].sort((a, b) => a.language.localeCompare(b.language) || a.id.localeCompare(b.id)) };
  return final;
}

/**
 * Rows whose outcome window is fully measured: the fetched history reaches back to T, or paging
 * stopped because there were no older pull requests (the repository's first one came after T), or
 * the outcome was completed by search.
 */
export function covered(row: BacktestRow, asOf: string): boolean {
  return row.completedBySearch === true || row.historyStart === undefined || row.historyStart <= asOf || !row.prsTruncated;
}

/** Which outcome a comparison grades on: pull requests (the original grade) or people (robust to one prolific author). */
export type Outcome = "prs" | "people";

/** The row with its grade, merged count and merge rate read from the chosen outcome. Rows without people counts keep their own. */
export function withOutcome(row: BacktestRow, outcome: Outcome): BacktestRow {
  if (outcome === "prs") return row;
  const g = gradePeople(row.outcome);
  if (g === undefined) return row;
  const o = row.outcome;
  return { ...row, grade: g, outcome: { ...o, merged: o.mergedNewcomers!, closedUnmerged: o.decidedNewcomers! - o.mergedNewcomers!, mergeRate: o.decidedNewcomers ? o.mergedNewcomers! / o.decidedNewcomers : undefined } };
}

export function toCandidate(row: BacktestRow): Candidate {
  return {
    id: row.id,
    language: row.language,
    score: row.score,
    excluded: row.excluded,
    stars: row.starsNow,
    starterIssuesAtT: row.starterIssuesAtT,
    daysSinceCommitAtT: row.daysSinceCommitAtT,
    priorNewcomerMergeRate: row.prior.mergeRate,
    priorNewcomerMerged: row.prior.merged,
    priorOutsiderMergeRate: row.priorOutsider?.mergeRate,
    priorOutsiderMerged: row.priorOutsider?.merged ?? 0,
    grade: row.grade,
    merged: row.outcome.merged,
  };
}

export interface RankingMetrics {
  ndcg: number;
  precision: number;
  auc: number | undefined;
  spearman: number | undefined;
}

export interface OddsMetric {
  /** Spearman correlation between the ranking key and the newcomer merge rate in the window, with a 95% bootstrap interval. */
  spearman: { estimate: number; lower: number; upper: number };
  /** AUC for separating repositories that merged at least half of newcomers' pull requests. */
  auc: number | undefined;
}

export interface Evaluation {
  k: number;
  /** Repositories with at least three decided newcomer pull requests in the window, pooled over languages. */
  oddsPool: number;
  /** Does the ranking pick projects where a newcomer's pull request is likely to be merged, regardless of how busy they are? */
  odds: Record<Ranking, OddsMetric | undefined>;
  /** Rows dropped because their fetched history did not reach back to T. */
  uncovered: number;
  /** Rows after exclusion, per language. */
  pools: { language: string; candidates: number; eligible: number; grades: number[] }[];
  /** Macro-averaged over languages. */
  overall: Record<Ranking, RankingMetrics>;
  perLanguage: Record<string, Record<Ranking, RankingMetrics>>;
  /** nDCG@k of each ranking minus gitgoblin's, with a 95% bootstrap interval. */
  ndcgDelta: Record<Ranking, { estimate: number; lower: number; upper: number }>;
}

function metricsFor(pool: Candidate[], ranking: Ranking, k: number): RankingMetrics {
  const ranked = rankCandidates(pool, ranking);
  const key = (c: Candidate) => (ranking === "random" ? 0 : (rankingKey(ranking, c) ?? Number.NEGATIVE_INFINITY));
  return {
    ndcg: ndcgAtK(ranked.map((c) => c.grade), k),
    precision: precisionAtK(ranked.map((c) => c.grade >= 2), k),
    auc: ranking === "random" ? undefined : auc(ranked.filter((c) => c.grade >= 1).map(key), ranked.filter((c) => c.grade === 0).map(key)),
    spearman: ranking === "random" ? undefined : spearman(ranked.map(key), ranked.map((c) => c.merged)),
  };
}

function macro(values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? known.reduce((s, v) => s + v, 0) / known.length : undefined;
}

function byLanguage(cands: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) groups.set(c.language, [...(groups.get(c.language) ?? []), c]);
  return groups;
}

export interface EvaluateOptions {
  k?: number | undefined;
  iterations?: number | undefined;
  seed?: number | undefined;
  /**
   * Sensitivity check: keep repositories whose history did not reach back to T (the busiest,
   * mostly very popular ones), each given the best grade, 3. Their as-of scores also lack pre-T
   * pull requests, so this is the most favourable case for popularity and the least favourable for
   * gitgoblin; a result that survives it does not depend on leaving them out.
   */
  includeUncovered?: boolean | undefined;
  /** Grade on pull requests (default) or on people. */
  outcome?: Outcome | undefined;
}

export function evaluate(dataset: Pick<BacktestDataset, "rows" | "asOf">, options: EvaluateOptions = {}): Evaluation {
  const k = options.k ?? 10;
  const rows = dataset.rows.map((row) => withOutcome(row, options.outcome ?? "prs"));
  const usable = options.includeUncovered
    ? rows.map((row) => (covered(row, dataset.asOf) ? row : { ...row, grade: 3 }))
    : rows.filter((row) => covered(row, dataset.asOf));
  const cands = usable.map(toCandidate);
  const groups = byLanguage(cands);
  const perLanguage: Evaluation["perLanguage"] = {};
  for (const [language, pool] of groups) {
    perLanguage[language] = Object.fromEntries(RANKINGS.map((r) => [r, metricsFor(pool, r, k)])) as Record<Ranking, RankingMetrics>;
  }
  const overall = Object.fromEntries(
    RANKINGS.map((r) => {
      const ms = [...groups.keys()].map((l) => perLanguage[l]![r]);
      return [r, { ndcg: macro(ms.map((m) => m.ndcg)) ?? 0, precision: macro(ms.map((m) => m.precision)) ?? 0, auc: macro(ms.map((m) => m.auc)), spearman: macro(ms.map((m) => m.spearman)) }];
    }),
  ) as Record<Ranking, RankingMetrics>;

  const macroNdcg = (sample: Candidate[], r: Ranking) => macro([...byLanguage(sample).values()].map((pool) => metricsFor(pool, r, k).ndcg)) ?? 0;
  const ndcgDelta = Object.fromEntries(
    RANKINGS.map((r) => {
      const b = bootstrap(cands.length, (idx) => {
        const sample = idx.map((i) => cands[i]!);
        return macroNdcg(sample, r) - macroNdcg(sample, "gitgoblin");
      }, { iterations: options.iterations ?? 1000, seed: options.seed ?? 1 });
      return [r, { estimate: b.estimate, lower: b.lower, upper: b.upper }];
    }),
  ) as Evaluation["ndcgDelta"];

  const decided = cands.filter((c, i) => !c.excluded && usable[i]!.outcome.merged + usable[i]!.outcome.closedUnmerged >= 3);
  const rates = new Map(usable.map((row) => [row.id, row.outcome.mergeRate ?? 0]));
  const odds = Object.fromEntries(
    RANKINGS.map((r) => {
      if (r === "random" || decided.length < 10) return [r, undefined];
      const xs = decided.map((c) => rankingKey(r, c) ?? Number.NEGATIVE_INFINITY);
      const ys = decided.map((c) => rates.get(c.id)!);
      const b = bootstrap(decided.length, (idx) => spearman(idx.map((i) => xs[i]!), idx.map((i) => ys[i]!)) ?? 0, { iterations: options.iterations ?? 1000, seed: options.seed ?? 1 });
      const pos = decided.flatMap((c, i) => (ys[i]! >= 0.5 ? [xs[i]!] : []));
      const neg = decided.flatMap((c, i) => (ys[i]! < 0.5 ? [xs[i]!] : []));
      return [r, { spearman: { estimate: b.estimate, lower: b.lower, upper: b.upper }, auc: auc(pos, neg) }];
    }),
  ) as Evaluation["odds"];

  return {
    k,
    oddsPool: decided.length,
    odds,
    uncovered: dataset.rows.length - usable.length,
    pools: [...groups].map(([language, pool]) => ({ language, candidates: pool.length, eligible: pool.filter((c) => !c.excluded).length, grades: pool.filter((c) => !c.excluded).map((c) => c.grade) })),
    overall,
    perLanguage,
    ndcgDelta,
  };
}

/**
 * Examples for the held-out fit: discovery's signals as of T (recomputed from
 * the stored `EnrichedRepo` with discovery's own code) plus the behavioural
 * counts discovery does not use today.
 */
export function examplesFrom(dataset: Pick<BacktestDataset, "rows" | "asOf">, minGrade = 1): Example[] {
  const now = Date.parse(dataset.asOf);
  return dataset.rows
    .filter((row) => !row.excluded && covered(row, dataset.asOf))
    .map((row) => {
      const { signals } = computeSignals(row.enriched, now);
      return {
        group: row.language,
        features: {
          ...signals,
          priorNewcomerMergeRate: row.prior.mergeRate,
          priorNewcomerMerged: Math.log1p(row.prior.merged),
          priorOutsiderMergeRate: row.priorOutsider?.mergeRate,
          priorOutsiderMerged: Math.log1p(row.tracker.outsiderMerged),
          starterIssuesAtT: Math.log1p(row.starterIssuesAtT),
        },
        label: row.grade >= minGrade,
        baseline: row.score,
      };
    });
}

export const LEARN_FEATURES = [
  "activity", "responsiveness", "busFactor", "newcomerFriendliness", "docs", "maturity", "popularity", "momentum", "license",
  "priorNewcomerMergeRate", "priorNewcomerMerged", "priorOutsiderMergeRate", "priorOutsiderMerged", "starterIssuesAtT",
];

/**
 * Re-scores every row from its stored as-of input with the discovery code checked out now, so a
 * change to discovery's signals or weights can be measured on the same past without fetching again.
 */
export function rescore<D extends Pick<BacktestDataset, "rows" | "asOf">>(dataset: D): D {
  const now = Date.parse(dataset.asOf);
  return {
    ...dataset,
    rows: dataset.rows.map((row) => {
      const scored = scoreRepo(row.enriched, "contribute", { now });
      return { ...row, score: scored.score, excluded: scored.excluded, reasons: scored.reasons.slice(0, 4) };
    }),
  };
}
