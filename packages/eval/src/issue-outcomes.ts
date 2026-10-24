/**
 * E4: are the issues intel accepts the ones outsiders go on to resolve, more often than the issues a
 * label or a maintainer's comment points at? Issues open at T are assessed as they looked then
 * (`issueAsOf`, intel's own classifier, clock at T) and graded by what happened in the window after:
 * closed as completed by a merged pull request from an outsider, completed by any means, or closed as
 * not planned. Every selection is measured on the same issues.
 */
import { assessIssue, type BacktestIssue, fetchIssueSamples, type GitHubApi, issueAsOf } from "@gitgoblin/intel/backtest";
import { createSources, type GitHubClient, STARTER_ISSUE_LABELS } from "@gitgoblin/sources";
import { graphqlReset, withRateLimitRetry } from "./github/history.ts";
import { bootstrap } from "./metrics.ts";
import { MAINTAINER_ASSOCIATIONS, type Window } from "./outcomes.ts";

const DAY_MS = 86_400_000;

export const SELECTIONS = ["all", "intelAccepted", "intelTriage", "starterLabel", "maintainerEngaged", "recent"] as const;
export type Selection = (typeof SELECTIONS)[number];

export const SELECTION_LABELS: Record<Selection, string> = {
  all: "every issue open at T",
  intelAccepted: "intel accepts it (issue or feature request)",
  intelTriage: "intel calls it triage",
  starterLabel: "carries a starter label",
  maintainerEngaged: "a maintainer commented before T",
  recent: "opened in the 90 days before T",
};

export interface IssueRow {
  repo: string;
  number: number;
  createdAt: string;
  selections: Selection[];
  /** intel's verdict at T: kind, or the reason it passed the issue over. */
  verdict: string;
  outcome: "outsider_pr" | "maintainer_pr" | "completed_other" | "not_planned" | "open_or_later";
}

/** What happened to an issue in the window. */
export function issueOutcome(issue: BacktestIssue, window: Window): IssueRow["outcome"] {
  const inWindow = (iso: string | undefined) => iso !== undefined && iso >= window.start && iso < window.end;
  if (!issue.closedAt || !inWindow(issue.closedAt)) return "open_or_later";
  if (issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE") return "not_planned";
  const pr = issue.closedBy;
  if (pr?.merged) return pr.authorIsBot || MAINTAINER_ASSOCIATIONS.has(pr.authorAssociation) ? "maintainer_pr" : "outsider_pr";
  return "completed_other";
}

/** Which selections an issue open at T belongs to, and intel's verdict on it. */
export function classify(issue: BacktestIssue, at: Date, repoUrl: string, starter: ReadonlySet<string>): { selections: Selection[]; verdict: string } {
  const asOf = issueAsOf(issue, at);
  const a = assessIssue(asOf, at, true, repoUrl);
  const selections: Selection[] = ["all"];
  if (!a.skipReason && (a.kind === "issue" || a.kind === "feature_request")) selections.push("intelAccepted");
  if (!a.skipReason && a.kind === "triage") selections.push("intelTriage");
  if (asOf.labels.some((l) => starter.has(l.toLowerCase()))) selections.push("starterLabel");
  if ([...asOf.firstComments, ...asOf.lastComments].some((c) => MAINTAINER_ASSOCIATIONS.has(c.association))) selections.push("maintainerEngaged");
  if (at.getTime() - Date.parse(issue.createdAt) <= 90 * DAY_MS) selections.push("recent");
  return { selections, verdict: a.skipReason ? `skip: ${a.skipReason.slice(0, 80)}` : a.kind };
}

/** intel's `GitHubApi` over the shared client, cached long so a snapshot can be re-read offline. */
export function intelApi(github: GitHubClient): GitHubApi {
  const ttlMs = 90 * DAY_MS;
  return {
    stats: { requests: 0 },
    rest: (path, params) => github.rest(path, { params, ttlMs }),
    graphql: (query, variables) => withRateLimitRetry(() => github.graphql(query, variables, { ttlMs }), () => {}, graphqlReset(github)),
  };
}

export interface RepoIssues {
  repo: string;
  issues: IssueRow[];
  /** Open issues were capped by the page limit, so the stalest ones may be missing. */
  openTruncated: boolean;
}

/** Issues open at T in one repository, classified at T and graded over the window. */
export async function repoIssues(api: GitHubApi, repo: string, window: Window, options: { maxOpenPages?: number; maxClosedPages?: number } = {}): Promise<RepoIssues> {
  const [owner, name] = repo.split("/") as [string, string];
  const at = new Date(window.start);
  const starter = new Set(STARTER_ISSUE_LABELS.map((l) => l.toLowerCase()));
  const repoUrl = `https://github.com/${repo}`;
  const collected: BacktestIssue[] = [];
  // Closed issues come newest-updated first; anything closed after T was updated after T, so stop once updates fall before it.
  let after: string | undefined;
  for (let page = 0; page < (options.maxClosedPages ?? 6); page++) {
    const res = await fetchIssueSamples(api, owner, name, { states: ["CLOSED"], first: 50, after });
    collected.push(...res.issues.filter((i) => i.closedAt !== undefined && i.closedAt >= window.start));
    if (!res.hasNextPage || res.issues.every((i) => i.updatedAt < window.start)) break;
    after = res.endCursor;
  }
  let openTruncated = false;
  after = undefined;
  for (let page = 0; ; page++) {
    if (page >= (options.maxOpenPages ?? 4)) { openTruncated = true; break; }
    const res = await fetchIssueSamples(api, owner, name, { states: ["OPEN"], first: 50, after });
    collected.push(...res.issues);
    if (!res.hasNextPage) break;
    after = res.endCursor;
  }
  const openAtT = collected.filter((i) => i.createdAt < window.start && !i.author?.isBot);
  const issues = openAtT.map((issue) => ({ repo, number: issue.number, createdAt: issue.createdAt, ...classify(issue, at, repoUrl, starter), outcome: issueOutcome(issue, window) }));
  return { repo, issues, openTruncated };
}

export interface IssueOutcomeDataset {
  experiment: "issue-outcomes";
  asOf: string;
  windowDays: number;
  fetchedAt: string;
  repos: RepoIssues[];
  skipped: { repo: string; reason: string }[];
}

export async function fetchIssueOutcomes(repos: string[], asOf: string, windowDays: number, options: { cachePath?: string | undefined; log?: ((m: string) => void) | undefined; resume?: IssueOutcomeDataset | undefined } = {}): Promise<IssueOutcomeDataset> {
  const log = options.log ?? (() => {});
  const t = Date.parse(asOf);
  const window: Window = { start: new Date(t).toISOString(), end: new Date(t + windowDays * DAY_MS).toISOString() };
  const sources = await createSources({ cachePath: options.cachePath });
  const api = intelApi(sources.github);
  // A resumed run keeps what it measured and retries what failed.
  const out: RepoIssues[] = [...(options.resume?.repos ?? [])];
  const done = new Set(out.map((r) => r.repo));
  const skipped: IssueOutcomeDataset["skipped"] = [];
  try {
    for (const repo of repos) {
      if (done.has(repo)) continue;
      try {
        const r = await repoIssues(api, repo, window);
        out.push(r);
        log(`${repo}: ${r.issues.length} issues open at T, ${r.issues.filter((i) => i.outcome === "outsider_pr").length} resolved by an outsider's pull request`);
      } catch (error) {
        const reason = (error as Error).message.split("\n")[0] ?? "unknown";
        skipped.push({ repo, reason });
        log(`${repo}: skipped: ${reason}`);
      }
    }
  } finally {
    sources.close();
  }
  return { experiment: "issue-outcomes", asOf: window.start, windowDays, fetchedAt: new Date().toISOString(), repos: out, skipped };
}

export interface SelectionSummary {
  issues: number;
  repositories: number;
  outsiderPr: { estimate: number; lower: number; upper: number };
  completed: number;
  notPlanned: number;
}

/** Shares per selection, with a 95% interval from resampling repositories (issues in one repository are not independent). */
export function summarize(dataset: Pick<IssueOutcomeDataset, "repos">, options: { iterations?: number | undefined; seed?: number | undefined } = {}): Record<Selection, SelectionSummary> {
  const repos = dataset.repos;
  const share = (idx: number[], sel: Selection, test: (o: IssueRow["outcome"]) => boolean) => {
    let n = 0;
    let hit = 0;
    for (const i of idx) for (const issue of repos[i]!.issues) if (issue.selections.includes(sel)) { n++; if (test(issue.outcome)) hit++; }
    return n ? hit / n : 0;
  };
  const all = repos.map((_, i) => i);
  return Object.fromEntries(SELECTIONS.map((sel) => {
    const issues = repos.flatMap((r) => r.issues.filter((i) => i.selections.includes(sel)));
    const b = bootstrap(repos.length, (idx) => share(idx, sel, (o) => o === "outsider_pr"), { iterations: options.iterations ?? 1000, seed: options.seed ?? 1 });
    return [sel, {
      issues: issues.length,
      repositories: repos.filter((r) => r.issues.some((i) => i.selections.includes(sel))).length,
      outsiderPr: { estimate: b.estimate, lower: b.lower, upper: b.upper },
      completed: share(all, sel, (o) => o === "outsider_pr" || o === "maintainer_pr" || o === "completed_other"),
      notPlanned: share(all, sel, (o) => o === "not_planned"),
    }];
  })) as Record<Selection, SelectionSummary>;
}
