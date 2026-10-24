/**
 * Completes the repositories the discovery backtest had to leave out: the busiest ones, whose pull
 * request history was too long to page back to the as-of date. GitHub search, which can filter by
 * date, gives what is needed without paging through everything newer:
 *
 * - the window's pull requests, in date slices of at most 1,000 results each;
 * - for each outside author in the window, whether they opened a pull request in the year before
 *   their first window one (one count per author, many authors per query), which decides who is a
 *   newcomer exactly as `newcomerOutcomes` does for the other repositories;
 * - counts for the year before T (pull requests, merged pull requests, issues), from which
 *   discovery's past-year statistics are rebuilt. Average close times are not available this way
 *   and stay unknown.
 */
import type { GitHubClient } from "@gitgoblin/sources";
import type { BacktestDataset, BacktestRow } from "./discovery-backtest.ts";
import { graphqlReset, toPrRow, withRateLimitRetry } from "./github/history.ts";
import { gradeOutcome, MAINTAINER_ASSOCIATIONS, type NewcomerOutcome, newcomerOutcomes, type OutsiderOutcome, outsiderOutcomes, type PrRow, type Window } from "./outcomes.ts";

const DAY_MS = 86_400_000;

/** Splits [start, end) into slices of `days`, as `YYYY-MM-DDTHH:MM:SSZ..` search ranges. */
export function slices(window: Window, days: number): Window[] {
  const out: Window[] = [];
  const end = Date.parse(window.end);
  for (let t = Date.parse(window.start); t < end; t += days * DAY_MS) {
    out.push({ start: new Date(t).toISOString(), end: new Date(Math.min(end, t + days * DAY_MS)).toISOString() });
  }
  return out;
}

/** GitHub search range for [start, end): the end is exclusive, so stop one second before it. */
export function searchRange(window: Window): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${iso(Date.parse(window.start))}..${iso(Date.parse(window.end) - 1000)}`;
}

/**
 * The newcomer outcome from window pull requests and the set of outside authors who had a pull
 * request in the year before their first window one. Authors with earlier work get a synthetic
 * earlier pull request so `newcomerOutcomes` treats them exactly as it treats a full history.
 */
export function outcomeFromWindow(windowPrs: PrRow[], returning: ReadonlySet<string>, window: Window): NewcomerOutcome {
  const before = new Date(Date.parse(window.start) - DAY_MS).toISOString();
  const synthetic: PrRow[] = [...returning].map((author, i) => ({
    number: -1 - i, createdAt: before, state: "MERGED", mergedAt: before, author, authorIsBot: false, association: "CONTRIBUTOR",
    additions: 0, deletions: 0, changedFiles: 0, linkedIssues: 0, labels: [],
  }));
  return newcomerOutcomes([...windowPrs, ...synthetic], window, new Date(Date.parse(window.start) - 365 * DAY_MS).toISOString());
}

// Only what the outcome needs: who, when, what happened, and the first response for grade 3.
const PR_FIELDS = `... on PullRequest {
  number createdAt mergedAt closedAt state authorAssociation
  author { login __typename }
  reviews(first: 1) { nodes { createdAt author { login __typename } } }
  comments(first: 2) { nodes { createdAt author { login __typename } } }
}`;

// For the year before T only who opened what, and when it was decided, are needed.
const LIGHT_FIELDS = `... on PullRequest { number createdAt mergedAt closedAt state authorAssociation author { login __typename } }`;

const searchPrs = (first: number, fields: string) => `query($q: String!, $after: String) { search(type: ISSUE, query: $q, first: ${first}, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`;

/** A search page, retried at half the size when GitHub answers 502 (the query was too heavy for it). */
async function searchPage(github: GitHubClient, q: string, after: string | null, fields: string, log: (m: string) => void): Promise<{ issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] }> {
  for (const size of [100, 50, 25]) {
    try {
      return (await withRateLimitRetry(() => github.graphql<{ search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] } }>(searchPrs(size, fields), { q, after }, { ttlMs: 90 * DAY_MS }), log, graphqlReset(github))).search;
    } catch (error) {
      if (!/HTTP 50[23]/.test((error as Error).message) || size === 25) throw error;
    }
  }
  throw new Error("unreachable");
}

async function count(github: GitHubClient, queries: Record<string, string>): Promise<Record<string, number>> {
  const keys = Object.keys(queries);
  const result: Record<string, number> = {};
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    const body = batch.map((k, j) => `c${j}: search(type: ISSUE, query: ${JSON.stringify(queries[k])}, first: 0) { issueCount }`).join("\n");
    const data = await withRateLimitRetry(() => github.graphql<Record<string, { issueCount: number }>>(`query { ${body} }`, {}, { ttlMs: 90 * DAY_MS }), () => {}, graphqlReset(github));
    batch.forEach((k, j) => (result[k] = data[`c${j}`]?.issueCount ?? 0));
  }
  return result;
}

/** Every pull request created in the window, by search, splitting any slice that hits the 1,000-result cap. */
export async function windowPullRequests(github: GitHubClient, repo: string, window: Window, log: (m: string) => void = () => {}, fields: string = PR_FIELDS): Promise<PrRow[]> {
  const rows: PrRow[] = [];
  const queue = slices(window, 30);
  while (queue.length) {
    const slice = queue.shift()!;
    const q = `repo:${repo} is:pr created:${searchRange(slice)}`;
    const first = await searchPage(github, q, null, fields, log);
    const days = (Date.parse(slice.end) - Date.parse(slice.start)) / DAY_MS;
    if (first.issueCount > 1000 && days > 1) {
      queue.unshift(...slices(slice, Math.max(1, Math.floor(days / Math.ceil(first.issueCount / 900)))));
      continue;
    }
    let page = first;
    for (;;) {
      for (const node of page.nodes) {
        if (!node || (node as { number?: number }).number === undefined) continue;
        rows.push(toPrRow({ additions: 0, deletions: 0, changedFiles: 0, closingIssuesReferences: { totalCount: 0 }, reviews: { nodes: [] }, comments: { nodes: [] }, ...(node as object) } as unknown as Parameters<typeof toPrRow>[0]));
      }
      if (!page.pageInfo.hasNextPage) break;
      page = await searchPage(github, q, page.pageInfo.endCursor, fields, log);
    }
  }
  return rows;
}

export interface Completion {
  outcome: NewcomerOutcome;
  /** Over the year before T with no earlier history, so it over-counts newcomers; reported, not applied to rows. */
  prior: NewcomerOutcome;
  priorOutsider: OutsiderOutcome;
  pastYear: { pullRequests: number; mergedPullRequests: number; issues: number; prAuthors: number; avgTimeToClosePrSec: number | undefined };
  mergedBeforeT: number;
  windowPrs: number;
}

/**
 * The window's pull requests and the year before T, both by search, then the same
 * `newcomerOutcomes` the paged histories use: a newcomer is an outside author with no pull request
 * in the year before their first one in the window.
 */
export async function completeRepository(github: GitHubClient, repo: string, asOf: string, windowDays: number, log: (m: string) => void = () => {}): Promise<Completion> {
  const t = Date.parse(asOf);
  const window: Window = { start: new Date(t).toISOString(), end: new Date(t + windowDays * DAY_MS).toISOString() };
  const year: Window = { start: new Date(t - 365 * DAY_MS).toISOString(), end: window.start };
  const windowPrs = await windowPullRequests(github, repo, window, log);
  const priorPrs = await windowPullRequests(github, repo, year, log, LIGHT_FIELDS);
  const all = [...priorPrs, ...windowPrs];
  const counts = await count(github, {
    issues: `repo:${repo} is:issue created:${searchRange(year)}`,
    mergedBefore: `repo:${repo} is:pr is:merged merged:<${asOf.slice(0, 10)}`,
  });
  const decided = priorPrs.filter((p) => (p.mergedAt ?? p.closedAt) !== undefined && (p.mergedAt ?? p.closedAt)! < window.start);
  const closeSec = decided.map((p) => (Date.parse((p.mergedAt ?? p.closedAt)!) - Date.parse(p.createdAt)) / 1000);
  return {
    outcome: newcomerOutcomes(all, window, year.start),
    prior: newcomerOutcomes(priorPrs, year, year.start),
    priorOutsider: outsiderOutcomes(priorPrs, year),
    pastYear: {
      pullRequests: priorPrs.length,
      mergedPullRequests: priorPrs.filter((p) => p.mergedAt !== undefined && p.mergedAt < window.start).length,
      issues: counts.issues ?? 0,
      prAuthors: new Set(priorPrs.filter((p) => !p.authorIsBot && p.author).map((p) => p.author)).size,
      avgTimeToClosePrSec: closeSec.length ? closeSec.reduce((a, b) => a + b, 0) / closeSec.length : undefined,
    },
    mergedBeforeT: counts.mergedBefore ?? 0,
    windowPrs: windowPrs.length,
  };
}

/** Applies a completion to a row: outcome, grade, prior-year baselines, and discovery's past-year statistics as of T. */
export function applyCompletion(row: BacktestRow, c: Completion): BacktestRow {
  const old = row.enriched.issueStats?.pastYear;
  const pastYear = { issueAuthors: old?.issueAuthors ?? 0, avgTimeToCloseIssueSec: undefined, ...c.pastYear };
  const issueStats = { issues: pastYear.issues, pullRequests: pastYear.pullRequests, mergedPullRequests: pastYear.mergedPullRequests, avgTimeToCloseIssueSec: undefined, avgTimeToClosePrSec: pastYear.avgTimeToClosePrSec, pastYear };
  const details = row.enriched.details ? { ...row.enriched.details, mergedPullRequests: c.mergedBeforeT } : undefined;
  // The prior-year newcomer measure needs history before the prior year, which search did not fetch, so it stays unknown here;
  // the outside-contributor measure needs no such lookback and is exact.
  const prior: NewcomerOutcome = { newcomers: 0, pullRequests: 0, merged: 0, closedUnmerged: 0, open: 0, mergeRate: undefined, medianResponseHours: undefined, partialCoverage: true };
  return { ...row, enriched: { ...row.enriched, issueStats, details }, outcome: c.outcome, grade: gradeOutcome(c.outcome), prior, priorOutsider: c.priorOutsider, completedBySearch: true };
}

export async function completeBusy(dataset: BacktestDataset, github: GitHubClient, options: { concurrency?: number | undefined; log?: ((m: string) => void) | undefined; checkpoint?: ((d: BacktestDataset) => Promise<void>) | undefined } = {}): Promise<BacktestDataset> {
  const log = options.log ?? (() => {});
  const rows = [...dataset.rows];
  // Rows discovery excluded at T never enter the evaluation, so they are not worth the requests.
  const todo = rows.map((row, i) => ({ row, i })).filter(({ row }) => !row.completedBySearch && !row.excluded && row.historyStart !== undefined && row.historyStart > dataset.asOf && row.prsTruncated);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, todo.length) }, async () => {
    while (next < todo.length) {
      const { row, i } = todo[next++]!;
      const repo = row.id.replace(/^github\.com\//, "");
      try {
        const c = await completeRepository(github, repo, dataset.asOf, dataset.windowDays, (m) => log(`${repo}: ${m}`));
        rows[i] = applyCompletion(row, c);
        log(`${repo}: ${c.windowPrs} window pull requests, ${c.outcome.newcomers} newcomers, ${c.outcome.merged}/${c.outcome.pullRequests} merged, grade ${rows[i]!.grade}`);
        await options.checkpoint?.({ ...dataset, rows });
      } catch (error) {
        log(`${repo}: not completed: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }));
  return { ...dataset, rows };
}
