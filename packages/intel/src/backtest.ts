/**
 * Outcome backtests for intel's issue classifier: issues as intel samples them, with how they were closed and by
 * whom, the classifier itself, and an issue reconstructed as it looked at an earlier moment. Kept apart from the
 * main entry so evaluation code never needs intel internals.
 */
import type { GitHubApi } from "./github/client.ts";
import { mapIssueNode } from "./github/fetch.ts";
import { BACKTEST_ISSUES_QUERY } from "./github/queries.ts";
import { type AuthorAssociation, type IssueSample, isBotLogin } from "./github/types.ts";

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
 */
export function issueAsOf(issue: IssueSample, at: Date): IssueSample {
  const cutoff = at.getTime();
  return {
    ...issue,
    closedAt: undefined,
    locked: false,
    firstComments: issue.firstComments.filter((c) => Date.parse(c.createdAt) < cutoff),
    lastComments: issue.lastComments.filter((c) => Date.parse(c.createdAt) < cutoff),
    linkedPrs: issue.linkedPrs.filter((p) => p.state !== "MERGED" && Date.parse(p.updatedAt) < cutoff),
  };
}
