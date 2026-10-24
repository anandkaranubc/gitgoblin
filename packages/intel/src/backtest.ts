/**
 * Outcome backtests for intel's issue classifier: issues as intel samples them, with how they were closed and by
 * whom, the classifier itself, and an issue reconstructed as it looked at an earlier moment. Kept apart from the
 * main entry so evaluation code never needs intel internals.
 */
import type { GitHubApi } from "./github/client.ts";
import { mapIssueNode } from "./github/fetch.ts";
import { BACKTEST_ISSUES_QUERY } from "./github/queries.ts";
import { type AuthorAssociation, type CommentSample, type IssueSample, isBotLogin } from "./github/types.ts";

import { type IssueAssessment, issueSignals } from "./analyzers/issues.ts";
import { aggregate, signalFactors } from "./evaluate/index.ts";

export { type IssueAssessment, assessIssue } from "./analyzers/issues.ts";
export type { CommentSample, IssueSample, LinkedPr } from "./github/types.ts";
export type { GitHubApi } from "./github/client.ts";

/** The pull request whose merge closed an issue. */
export interface ClosingPullRequest {
  number: number;
  url: string;
  merged: boolean;
  mergedAt: string | undefined;
  authorLogin: string | undefined;
  authorIsBot: boolean;
  /** OWNER, MEMBER and COLLABORATOR are maintainers; anything else is an outsider. */
  authorAssociation: AuthorAssociation;
}

export interface BacktestIssue extends IssueSample {
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | undefined;
  /** Set when the issue's last close was done by a pull request. */
  closedBy: ClosingPullRequest | undefined;
}

export interface IssuePage {
  issues: BacktestIssue[];
  endCursor: string | undefined;
  hasNextPage: boolean;
}

interface Node {
  stateReason?: BacktestIssue["stateReason"] | null;
  closedBy?: { nodes: ({ closer?: { __typename?: string; number?: number; url?: string; merged?: boolean; mergedAt?: string | null; authorAssociation?: AuthorAssociation; author?: { login: string; __typename?: string } | null } | null } | null)[] } | null;
}

/** One page of issues, newest activity first. Page with `after` set to the previous `endCursor`. */
export async function fetchIssueSamples(api: GitHubApi, owner: string, name: string, options: { states?: ("OPEN" | "CLOSED")[]; first?: number; after?: string | undefined } = {}): Promise<IssuePage> {
  const data = await api.graphql<{ repository: { issues: { pageInfo: { endCursor: string | null; hasNextPage: boolean }; nodes: (unknown | null)[] } } | null }>(BACKTEST_ISSUES_QUERY, {
    owner, name, first: Math.min(options.first ?? 50, 100), after: options.after ?? null, states: options.states ?? ["CLOSED"],
  });
  const conn = data.repository?.issues;
  if (!conn) return { issues: [], endCursor: undefined, hasNextPage: false };
  const issues: BacktestIssue[] = [];
  for (const node of conn.nodes) {
    if (!node) continue; // GitHub nulls nodes it could not resolve
    const raw = node as Node;
    const closer = raw.closedBy?.nodes?.find((n) => n?.closer)?.closer;
    const closedBy = closer?.__typename === "PullRequest" && closer.number && closer.url
      ? {
          number: closer.number, url: closer.url, merged: closer.merged ?? false, mergedAt: closer.mergedAt ?? undefined,
          authorLogin: closer.author?.login, authorIsBot: closer.author ? closer.author.__typename === "Bot" || isBotLogin(closer.author.login) : false,
          authorAssociation: closer.authorAssociation ?? "NONE",
        }
      : undefined;
    issues.push({ ...mapIssueNode(node), stateReason: raw.stateReason ?? undefined, closedBy });
  }
  return { issues, endCursor: conn.pageInfo.endCursor ?? undefined, hasNextPage: conn.pageInfo.hasNextPage };
}

/**
 * The issue as someone would have seen it at `at`: open, unlocked (bots lock on close), without comments made at or
 * after `at`, and without links to pull requests that were merged or touched since. Assess it with the clock at `at`.
 *
 * The comment count drops the sampled comments made since `at`; when every sampled recent comment is that late, more
 * may exist, so the count is an upper bound. The last update becomes the latest activity the sample shows before `at`
 * when the issue has changed since. Labels, assignees and reactions are today's: the API does not say what they were.
 */
export function issueAsOf(issue: IssueSample, at: Date): IssueSample {
  const cutoff = at.getTime();
  const before = (iso: string) => Date.parse(iso) < cutoff;
  const firstComments = issue.firstComments.filter((c) => before(c.createdAt));
  const lastComments = issue.lastComments.filter((c) => before(c.createdAt));
  const linkedPrs = issue.linkedPrs.filter((p) => p.state !== "MERGED" && before(p.updatedAt));
  // The first and last windows overlap on short threads; count each comment once.
  const key = (c: CommentSample) => `${c.createdAt}\u0000${c.author?.login ?? ""}`;
  const later = new Set([...issue.firstComments, ...issue.lastComments].filter((c) => !before(c.createdAt)).map(key));
  const kept = new Set([...firstComments, ...lastComments].map(key));
  const commentCount = Math.max(kept.size, issue.commentCount - later.size);
  const updatedAt = before(issue.updatedAt)
    ? issue.updatedAt
    : [issue.createdAt, ...firstComments.map((c) => c.createdAt), ...lastComments.map((c) => c.createdAt), ...linkedPrs.map((p) => p.updatedAt)].reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  return { ...issue, closedAt: undefined, locked: false, commentCount, updatedAt, firstComments, lastComments, linkedPrs };
}

/**
 * Intel's score for an issue it accepted, the number that orders issue opportunities within one repository's report,
 * computed from the issue alone. The repository's welcomeness is the same for every issue, so it is held at 0.75, a
 * typical value that leaves room for a help label's boost on it; files the issue names, discovery hints and the
 * model's review are left out, since a backtest has none of them. Compare scores within a repository, not across.
 */
export function issueScore(issue: IssueSample, assessment: IssueAssessment, at: Date): number {
  const { signals } = issueSignals(issue, assessment, at);
  return aggregate(signalFactors(signals, { score: 0.75, level: "open" }));
}
