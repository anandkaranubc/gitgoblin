/**
 * Sampling queries. GitHub nulls out nodes and reports RESOURCE_LIMITS_EXCEEDED
 * when one query is too heavy for a busy repository, so each connection is
 * fetched on its own with modest nested page sizes, and callers shrink `first`
 * when nodes come back null.
 */
const ACTOR = /* GraphQL */ `fragment ActorFields on Actor { login __typename }`;
const COMMENT_META = /* GraphQL */ `fragment CommentMeta on IssueComment { createdAt authorAssociation author { ...ActorFields } }`;

const ISSUE_FIELDS = /* GraphQL */ `
fragment IssueFields on Issue {
  number title url body createdAt updatedAt closedAt locked
  author { ...ActorFields }
  authorAssociation
  labels(first: 8) { nodes { name } }
  assignees(first: 3) { nodes { login } }
  reactions { totalCount }
  comments { totalCount }
  firstComments: comments(first: 3) { nodes { ...CommentMeta } }
  lastComments: comments(last: 6) { nodes { ...CommentMeta body } }
  timelineItems(first: 10, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
    nodes {
      ... on CrossReferencedEvent { source { ... on PullRequest { number url state isDraft updatedAt } } }
      ... on ConnectedEvent { subject { ... on PullRequest { number url state isDraft updatedAt } } }
    }
  }
}`;

/** Closed issues only feed response-time statistics. */
const ISSUE_LITE_FIELDS = /* GraphQL */ `
fragment IssueLiteFields on Issue {
  number title url createdAt updatedAt closedAt locked
  author { ...ActorFields }
  authorAssociation
  comments { totalCount }
  firstComments: comments(first: 3) { nodes { ...CommentMeta } }
}`;

const PR_FIELDS = /* GraphQL */ `
fragment PrFields on PullRequest {
  number title url state isDraft merged mergedAt closedAt createdAt updatedAt mergeable
  author { ...ActorFields }
  authorAssociation
  additions deletions changedFiles headRefName
  labels(first: 8) { nodes { name } }
  closingIssuesReferences(first: 3) { nodes { number } }
  firstComments: comments(first: 3) { nodes { ...CommentMeta } }
  lastComments: comments(last: 4) { nodes { ...CommentMeta body } }
  reviews(last: 3) { nodes { state createdAt authorAssociation author { ...ActorFields } } }
}`;

/** Closed PRs feed merge rates, response times and conventions; no comment bodies needed. */
const PR_LITE_FIELDS = /* GraphQL */ `
fragment PrLiteFields on PullRequest {
  number title url state isDraft merged mergedAt closedAt createdAt updatedAt mergeable
  author { ...ActorFields }
  authorAssociation
  additions deletions changedFiles headRefName
  labels(first: 8) { nodes { name } }
  closingIssuesReferences(first: 3) { nodes { number } }
  firstComments: comments(first: 3) { nodes { ...CommentMeta } }
  reviews(first: 3) { nodes { state createdAt authorAssociation author { ...ActorFields } } }
}`;

export const OPEN_ISSUES_QUERY = /* GraphQL */ `
query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    isMirror
    labels(first: 100) { nodes { name } }
    pullRequests(states: OPEN) { totalCount }
    issues(first: $first, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount nodes { ...IssueFields } }
  }
}
${ISSUE_FIELDS}
${ACTOR}
${COMMENT_META}`;

export const CLOSED_ISSUES_QUERY = /* GraphQL */ `
query ClosedIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: CLOSED, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...IssueLiteFields } }
  }
}
${ISSUE_LITE_FIELDS}
${ACTOR}
${COMMENT_META}`;

export const OPEN_PRS_QUERY = /* GraphQL */ `
query OpenPullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PrFields } }
  }
}
${PR_FIELDS}
${ACTOR}
${COMMENT_META}`;

export const CLOSED_PRS_QUERY = /* GraphQL */ `
query ClosedPullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: [MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PrLiteFields } }
  }
}
${PR_LITE_FIELDS}
${ACTOR}
${COMMENT_META}`;

/** Recently closed issues with full fields and the maintainers' close reason, for backtesting the classifier. */
export const CLOSED_ISSUES_FULL_QUERY = /* GraphQL */ `
query ClosedIssuesFull($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, states: CLOSED, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { endCursor hasNextPage }
      nodes { ...IssueFields stateReason }
    }
  }
}
${ISSUE_FIELDS}
${ACTOR}
${COMMENT_META}`;

export interface SampleSizes {
  openIssues: number;
  closedIssues: number;
  openPrs: number;
  closedPrs: number;
}

export const DEFAULT_SAMPLE_SIZES: SampleSizes = { openIssues: 80, closedIssues: 40, openPrs: 40, closedPrs: 60 };
