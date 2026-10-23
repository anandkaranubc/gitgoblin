/**
 * Outcome labels from pull request and issue history. These are the ground
 * truth the experiments rank against: what newcomers actually managed to get
 * merged, and how much merged outside work came from the issue tracker.
 */

export const MAINTAINER_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface PrRow {
  number: number;
  createdAt: string;
  mergedAt?: string | undefined;
  closedAt?: string | undefined;
  state: "OPEN" | "MERGED" | "CLOSED";
  author?: string | undefined;
  authorIsBot: boolean;
  /** GitHub's authorAssociation at fetch time. */
  association: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Issues this pull request closes or references as closing. */
  linkedIssues: number;
  /** Earliest review or comment by someone other than the author. */
  firstResponseAt?: string | undefined;
  labels: string[];
}

export interface IssueRow {
  number: number;
  createdAt: string;
  closedAt?: string | undefined;
  stateReason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | null | undefined;
  author?: string | undefined;
  authorIsBot: boolean;
  association: string;
  labels: string[];
  /** Who authored the merged pull request that closed it, if any. */
  closedByPr: "outsider" | "maintainer" | "none";
}

export interface Window {
  /** Inclusive ISO start. */
  start: string;
  /** Exclusive ISO end. */
  end: string;
}

export interface NewcomerOutcome {
  /** Distinct outside authors whose first pull request fell in the window. */
  newcomers: number;
  /** Their pull requests created in the window. */
  pullRequests: number;
  merged: number;
  closedUnmerged: number;
  /** Still undecided at the window end. */
  open: number;
  /** merged / (merged + closedUnmerged); undefined when nothing was decided. */
  mergeRate: number | undefined;
  /** Median hours until a non-author responded, over newcomer pull requests with a response. */
  medianResponseHours: number | undefined;
  /** True when the fetched history starts less than a year before the window, so "first pull request" is less certain. */
  partialCoverage: boolean;
}

const DAY_MS = 86_400_000;

function inWindow(iso: string | undefined, window: Window): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= Date.parse(window.start) && t < Date.parse(window.end);
}

function isOutsider(row: { authorIsBot: boolean; association: string; author?: string | undefined }): boolean {
  return !row.authorIsBot && row.author !== undefined && !MAINTAINER_ASSOCIATIONS.has(row.association);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * What happened to newcomers who opened pull requests in the window.
 * `historyStart` is the creation date of the oldest fetched pull request; an
 * author with no earlier pull request in the fetched history counts as new.
 */
export function newcomerOutcomes(prs: PrRow[], window: Window, historyStart: string): NewcomerOutcome {
  const firstSeen = new Map<string, number>();
  for (const pr of prs) {
    if (!isOutsider(pr)) continue;
    const t = Date.parse(pr.createdAt);
    const seen = firstSeen.get(pr.author!);
    if (seen === undefined || t < seen) firstSeen.set(pr.author!, t);
  }
  const windowStart = Date.parse(window.start);
  const newcomers = new Set([...firstSeen].filter(([, t]) => t >= windowStart && t < Date.parse(window.end)).map(([a]) => a));

  let pullRequests = 0;
  let merged = 0;
  let closedUnmerged = 0;
  let open = 0;
  const responses: number[] = [];
  for (const pr of prs) {
    if (!isOutsider(pr) || !newcomers.has(pr.author!) || !inWindow(pr.createdAt, window)) continue;
    pullRequests++;
    if (pr.mergedAt && inWindow(pr.mergedAt, window)) merged++;
    else if (pr.closedAt && inWindow(pr.closedAt, window) && !pr.mergedAt) closedUnmerged++;
    else open++;
    if (pr.firstResponseAt) responses.push((Date.parse(pr.firstResponseAt) - Date.parse(pr.createdAt)) / 3_600_000);
  }
  const decided = merged + closedUnmerged;
  return {
    newcomers: newcomers.size,
    pullRequests,
    merged,
    closedUnmerged,
    open,
    mergeRate: decided > 0 ? merged / decided : undefined,
    medianResponseHours: median(responses),
    partialCoverage: windowStart - Date.parse(historyStart) < 365 * DAY_MS,
  };
}

/**
 * 0: no newcomer pull request merged. 1: at least one. 2: at least two and a
 * merge rate of at least a half. 3: grade 2 with a median first response
 * within a week.
 */
export function gradeOutcome(o: Pick<NewcomerOutcome, "merged" | "mergeRate" | "medianResponseHours">): 0 | 1 | 2 | 3 {
  if (o.merged === 0) return 0;
  if (o.merged < 2 || (o.mergeRate ?? 0) < 0.5) return 1;
  if (o.medianResponseHours !== undefined && o.medianResponseHours <= 7 * 24) return 3;
  return 2;
}

export interface TrackerStats {
  /** Merged pull requests by outsiders in the window. */
  outsiderMerged: number;
  /** Of those, how many reference an issue they close. */
  outsiderMergedWithIssue: number;
  /** Issues closed as completed in the window. */
  completedIssues: number;
  completedByAnyPr: number;
  completedByOutsiderPr: number;
}

/** How much of the merged outside work went through the tracker, and how much of the tracker outsiders resolved. */
export function trackerStats(prs: PrRow[], issues: IssueRow[], window: Window): TrackerStats {
  let outsiderMerged = 0;
  let outsiderMergedWithIssue = 0;
  for (const pr of prs) {
    if (!isOutsider(pr) || !inWindow(pr.mergedAt, window)) continue;
    outsiderMerged++;
    if (pr.linkedIssues > 0) outsiderMergedWithIssue++;
  }
  let completedIssues = 0;
  let completedByAnyPr = 0;
  let completedByOutsiderPr = 0;
  for (const issue of issues) {
    if (issue.stateReason !== "COMPLETED" || !inWindow(issue.closedAt, window)) continue;
    completedIssues++;
    if (issue.closedByPr !== "none") completedByAnyPr++;
    if (issue.closedByPr === "outsider") completedByOutsiderPr++;
  }
  return { outsiderMerged, outsiderMergedWithIssue, completedIssues, completedByAnyPr, completedByOutsiderPr };
}
