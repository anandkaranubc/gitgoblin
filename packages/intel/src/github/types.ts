/** Normalised repository metadata from the REST API. */
export interface RepoMeta {
  owner: string;
  name: string;
  defaultBranch: string;
  description: string | undefined;
  homepage: string | undefined;
  topics: string[];
  stars: number;
  forks: number;
  watchers: number;
  openIssuesAndPrs: number;
  license: string | undefined;
  archived: boolean;
  disabled: boolean;
  isFork: boolean;
  isTemplate: boolean;
  hasIssues: boolean;
  /** Repository size reported by GitHub, in kilobytes. */
  sizeKb: number;
  createdAt: string;
  pushedAt: string;
}

export interface Actor {
  login: string;
  isBot: boolean;
}

export type AuthorAssociation =
  | "OWNER"
  | "MEMBER"
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIME_CONTRIBUTOR"
  | "FIRST_TIMER"
  | "MANNEQUIN"
  | "NONE";

export interface CommentSample {
  createdAt: string;
  author: Actor | undefined;
  association: AuthorAssociation;
  body: string | undefined;
}

export interface LinkedPr {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  updatedAt: string;
}

export interface IssueSample {
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | undefined;
  locked: boolean;
  author: Actor | undefined;
  association: AuthorAssociation;
  labels: string[];
  assignees: string[];
  reactions: number;
  commentCount: number;
  /** Earliest comments, for response-time measurement. */
  firstComments: CommentSample[];
  /** Latest comments, for claim detection and maintainer stance. */
  lastComments: CommentSample[];
  linkedPrs: LinkedPr[];
  /** False when the item has comments that could not be read (forge APIs without a token); reply and response statistics skip it. */
  commentsFetched?: boolean | undefined;
  /** Pull or merge requests the forge counts for the issue that could not be read (lookup failed or not made). */
  unreadLinkedPrs?: number | undefined;
}

export interface ReviewSample {
  state: string;
  createdAt: string;
  author: Actor | undefined;
  association: AuthorAssociation;
}

export interface PrSample {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  merged: boolean;
  mergedAt: string | undefined;
  closedAt: string | undefined;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  author: Actor | undefined;
  association: AuthorAssociation;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  labels: string[];
  closingIssues: number[];
  firstComments: CommentSample[];
  lastComments: CommentSample[];
  reviews: ReviewSample[];
  /** False when comments and reviews exist but were not read (other forges); response statistics skip it. */
  commentsFetched?: boolean | undefined;
}

export interface LabelSample {
  name: string;
  openIssues: number;
}

/** Everything GraphQL tells us in one round trip. */
export interface GitHubSamples {
  isMirror: boolean;
  openIssueCount: number;
  openPrCount: number;
  labels: LabelSample[];
  openIssues: IssueSample[];
  closedIssues: IssueSample[];
  openPrs: PrSample[];
  closedPrs: PrSample[];
}

export interface Release {
  tagName: string;
  publishedAt: string;
  prerelease: boolean;
}

export interface WorkflowRun {
  id: number;
  /** Workflow display name, e.g. "CI". */
  name: string;
  /** Workflow file, e.g. ".github/workflows/ci.yml". */
  path: string;
  workflowId: number;
  event: string;
  conclusion: string | undefined;
  headSha: string;
  updatedAt: string;
  /** Greater than 1 when someone re-ran the workflow. */
  attempt: number;
  url: string;
}

export interface FailedJob {
  name: string;
  url: string;
  failedSteps: string[];
}

export const MAINTAINER_ASSOCIATIONS: ReadonlySet<AuthorAssociation> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export function isMaintainer(association: AuthorAssociation): boolean {
  return MAINTAINER_ASSOCIATIONS.has(association);
}

const BOT_LOGINS = new Set([
  "dependabot", "renovate", "renovate-bot", "github-actions", "codecov", "codecov-io",
  "coveralls", "greenkeeper", "snyk-bot", "pre-commit-ci", "allcontributors", "stale",
  "mergify", "netlify", "vercel", "sonarcloud", "imgbot", "pyup-bot", "copilot",
]);

/** Comment text without quoted lines ("> ..."), which repeat someone else's words. */
export function unquoted(body: string | undefined): string {
  return (body ?? "").split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
}

export function isBotLogin(login: string): boolean {
  const lower = login.toLowerCase();
  return lower.endsWith("[bot]") || BOT_LOGINS.has(lower) || lower.endsWith("-bot");
}
