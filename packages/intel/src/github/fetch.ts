import { type GitHubApi, GitHubError } from "./client.ts";
import { CLOSED_ISSUES_QUERY, CLOSED_PRS_QUERY, DEFAULT_SAMPLE_SIZES, OPEN_ISSUES_QUERY, OPEN_PRS_QUERY, type SampleSizes } from "./queries.ts";
import {
  type Actor,
  type AuthorAssociation,
  type CommentSample,
  type FailedJob,
  type GitHubSamples,
  type IssueSample,
  type LinkedPr,
  type PrSample,
  type Release,
  type RepoMeta,
  type ReviewSample,
  type WorkflowRun,
  isBotLogin,
} from "./types.ts";

interface RestRepo {
  name: string;
  owner: { login: string };
  default_branch: string;
  description: string | null;
  homepage: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  open_issues_count: number;
  license: { spdx_id: string | null } | null;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  is_template?: boolean;
  has_issues: boolean;
  size: number;
  created_at: string;
  pushed_at: string;
}

export async function fetchRepoMeta(api: GitHubApi, owner: string, name: string): Promise<RepoMeta> {
  const r = await api.rest<RestRepo>(`/repos/${owner}/${name}`);
  const spdx = r.license?.spdx_id;
  return {
    owner: r.owner.login,
    name: r.name,
    defaultBranch: r.default_branch,
    description: r.description ?? undefined,
    homepage: r.homepage || undefined,
    topics: r.topics ?? [],
    stars: r.stargazers_count,
    forks: r.forks_count,
    watchers: r.subscribers_count ?? 0,
    openIssuesAndPrs: r.open_issues_count,
    license: spdx && spdx !== "NOASSERTION" ? spdx : undefined,
    archived: r.archived,
    disabled: r.disabled,
    isFork: r.fork,
    isTemplate: r.is_template ?? false,
    hasIssues: r.has_issues,
    sizeKb: r.size,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
  };
}

export async function fetchLanguages(api: GitHubApi, owner: string, name: string): Promise<Record<string, number>> {
  return api.rest<Record<string, number>>(`/repos/${owner}/${name}/languages`);
}

export async function fetchReleases(api: GitHubApi, owner: string, name: string): Promise<Release[]> {
  const rows = await api.rest<{ tag_name: string; published_at: string | null; prerelease: boolean; draft: boolean }[]>(
    `/repos/${owner}/${name}/releases`,
    { per_page: 10 },
  );
  return rows
    .filter((r) => !r.draft && r.published_at)
    .map((r) => ({ tagName: r.tag_name, publishedAt: r.published_at!, prerelease: r.prerelease }));
}

interface RestRun {
  id: number; name: string | null; path: string; workflow_id: number; event: string; conclusion: string | null;
  head_sha: string; updated_at: string; run_attempt?: number; html_url: string;
}

/** Recent completed runs on a branch, newest first. Dependabot graph updates and PR runs are excluded. */
export async function fetchWorkflowRuns(api: GitHubApi, owner: string, name: string, branch: string): Promise<WorkflowRun[]> {
  const data = await api.rest<{ workflow_runs: RestRun[] }>(`/repos/${owner}/${name}/actions/runs`, {
    branch, status: "completed", per_page: 40, exclude_pull_requests: "true",
  });
  return data.workflow_runs
    // Only events that exercise the branch itself; bot workflows on issue_comment, dynamic graph updates and PR runs say nothing about main.
    .filter((r) => ["push", "schedule", "workflow_dispatch", "release", "merge_group", "create"].includes(r.event) && r.conclusion !== "skipped")
    .map((r) => ({
      id: r.id, name: r.name ?? r.path, path: r.path, workflowId: r.workflow_id, event: r.event,
      conclusion: r.conclusion ?? undefined, headSha: r.head_sha, updatedAt: r.updated_at, attempt: r.run_attempt ?? 1, url: r.html_url,
    }));
}

/** Jobs that failed in a run, with the names of their failing steps. */
export async function fetchFailedJobs(api: GitHubApi, owner: string, name: string, runId: number): Promise<FailedJob[]> {
  const data = await api.rest<{ jobs: { name: string; conclusion: string | null; html_url: string; steps?: { name: string; conclusion: string | null }[] }[] }>(
    `/repos/${owner}/${name}/actions/runs/${runId}/jobs`,
    { per_page: 50 },
  );
  return data.jobs
    .filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out")
    .map((j) => ({ name: j.name, url: j.html_url, failedSteps: (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name) }));
}

/**
 * Fetch issue and PR samples in four light queries. When GitHub nulls nodes
 * (RESOURCE_LIMITS_EXCEEDED), keep what came back and retry smaller if most were lost.
 */
export async function fetchSamples(api: GitHubApi, owner: string, name: string, sizes: SampleSizes = DEFAULT_SAMPLE_SIZES): Promise<GitHubSamples> {
  const vars = { owner, name };
  const open = await shrinking(sizes.openIssues, (first) => api.graphql<GqlOpenIssues>(OPEN_ISSUES_QUERY, { ...vars, first }), (d) => d.repository?.issues.nodes);
  const repo = open.data.repository;
  if (!repo) throw new GitHubError(`Repository ${owner}/${name} not found via GraphQL`, 404, "/graphql");
  const [closedIssues, openPrs, closedPrs] = await Promise.all([
    shrinking(sizes.closedIssues, (first) => api.graphql<GqlClosedIssues>(CLOSED_ISSUES_QUERY, { ...vars, first }), (d) => d.repository?.issues.nodes),
    shrinking(sizes.openPrs, (first) => api.graphql<GqlPrs>(OPEN_PRS_QUERY, { ...vars, first }), (d) => d.repository?.pullRequests.nodes),
    shrinking(sizes.closedPrs, (first) => api.graphql<GqlPrs>(CLOSED_PRS_QUERY, { ...vars, first }), (d) => d.repository?.pullRequests.nodes),
  ]);
  return {
    isMirror: repo.isMirror,
    openIssueCount: repo.issues.totalCount,
    openPrCount: repo.pullRequests.totalCount,
    // Per-label open counts are expensive server-side; the recent open sample is a good proxy.
    labels: present(repo.labels.nodes).map((l) => ({ name: l.name, openIssues: open.nodes.filter((i) => present(i.labels?.nodes).some((x) => x.name === l.name)).length })),
    openIssues: open.nodes.map(toIssue),
    closedIssues: closedIssues.nodes.map((i) => toIssue({ body: "", labels: null, assignees: null, reactions: null, lastComments: null, timelineItems: null, ...i })),
    openPrs: openPrs.nodes.map(toPr),
    closedPrs: closedPrs.nodes.map(toPr),
  };
}

/** Run a paged query, halving `first` while more than half the nodes come back null. */
export async function shrinking<D, N>(
  first: number,
  run: (first: number) => Promise<D>,
  pick: (data: D) => (N | null)[] | null | undefined,
): Promise<{ data: D; nodes: N[] }> {
  let size = first;
  let best: { data: D; nodes: N[] } | undefined;
  for (let attempt = 0; attempt < 3 && size >= 5; attempt++, size = Math.floor(size / 2)) {
    let data: D;
    try {
      data = await run(size);
    } catch (error) {
      if (best) return best;
      const transient = error instanceof GitHubError && (error.status >= 500 || /timeout|timed out|something went wrong|resource limits/i.test(error.message));
      if (!transient || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const raw = pick(data) ?? [];
    const nodes = present(raw);
    if (!best || nodes.length > best.nodes.length) best = { data, nodes };
    if (raw.length === 0 || nodes.length * 2 >= raw.length) return best;
  }
  return best ?? { data: await run(Math.max(size, 5)), nodes: [] };
}

/** GraphQL `nodes` lists are nullable element-wise; drop the holes. */
function present<T>(nodes: (T | null | undefined)[] | null | undefined): T[] {
  return (nodes ?? []).filter((n): n is T => n !== null && n !== undefined);
}

// GraphQL response shapes, kept private to this module.
interface GqlActor { login: string; __typename: string }
interface GqlComment { createdAt: string; authorAssociation: AuthorAssociation; author: GqlActor | null; body?: string }
interface GqlPrRef { number: number; url: string; state: LinkedPr["state"]; isDraft: boolean; updatedAt: string }
interface GqlIssue {
  number: number; title: string; url: string; body: string | null; createdAt: string; updatedAt: string;
  closedAt: string | null; locked: boolean; author: GqlActor | null; authorAssociation: AuthorAssociation;
  labels: { nodes: ({ name: string } | null)[] } | null; assignees: { nodes: ({ login: string } | null)[] } | null;
  reactions: { totalCount: number } | null; comments: { totalCount: number } | null;
  firstComments: { nodes: (GqlComment | null)[] } | null; lastComments: { nodes: (GqlComment | null)[] } | null;
  timelineItems: { nodes: ({ source?: Partial<GqlPrRef> | null; subject?: Partial<GqlPrRef> | null } | null)[] } | null;
}
type GqlIssueLite = Omit<GqlIssue, "body" | "labels" | "assignees" | "reactions" | "lastComments" | "timelineItems">;
interface GqlPr {
  number: number; title: string; url: string; state: PrSample["state"]; isDraft: boolean; merged: boolean;
  mergedAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string;
  mergeable: PrSample["mergeable"]; author: GqlActor | null; authorAssociation: AuthorAssociation;
  additions: number; deletions: number; changedFiles: number; headRefName: string;
  labels: { nodes: ({ name: string } | null)[] } | null; closingIssuesReferences: { nodes: ({ number: number } | null)[] } | null;
  firstComments: { nodes: (GqlComment | null)[] } | null; lastComments: { nodes: (GqlComment | null)[] } | null;
  reviews: { nodes: ({ state: string; createdAt: string; authorAssociation: AuthorAssociation; author: GqlActor | null } | null)[] } | null;
}
type GqlPrLite = Omit<GqlPr, "lastComments">;
interface GqlOpenIssues {
  repository: {
    isMirror: boolean;
    labels: { nodes: ({ name: string } | null)[] };
    pullRequests: { totalCount: number };
    issues: { totalCount: number; nodes: (GqlIssue | null)[] };
  } | null;
}
interface GqlClosedIssues { repository: { issues: { nodes: (GqlIssueLite | null)[] } } | null }
interface GqlPrs { repository: { pullRequests: { nodes: (GqlPr | GqlPrLite | null)[] } } | null }

function toActor(actor: GqlActor | null): Actor | undefined {
  if (!actor) return undefined;
  return { login: actor.login, isBot: actor.__typename === "Bot" || isBotLogin(actor.login) };
}

function toComment(c: GqlComment): CommentSample {
  return { createdAt: c.createdAt, author: toActor(c.author), association: c.authorAssociation, body: c.body };
}

/** Public for the backtest script, which maps closed issues fetched with the full fragment. */
export function mapIssueNode(node: unknown): IssueSample {
  return toIssue(node as GqlIssue);
}

function toIssue(i: GqlIssue): IssueSample {
  const linked = new Map<number, LinkedPr>();
  for (const item of present(i.timelineItems?.nodes)) {
    const pr = item.source ?? item.subject;
    if (pr?.number && pr.url && pr.state && pr.updatedAt) {
      linked.set(pr.number, { number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft ?? false, updatedAt: pr.updatedAt });
    }
  }
  return {
    number: i.number,
    title: i.title,
    url: i.url,
    body: i.body ?? "",
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt ?? undefined,
    locked: i.locked,
    author: toActor(i.author),
    association: i.authorAssociation,
    labels: present(i.labels?.nodes).map((l) => l.name),
    assignees: present(i.assignees?.nodes).map((a) => a.login),
    reactions: i.reactions?.totalCount ?? 0,
    commentCount: i.comments?.totalCount ?? 0,
    firstComments: present(i.firstComments?.nodes).map(toComment),
    lastComments: present(i.lastComments?.nodes).map(toComment),
    linkedPrs: [...linked.values()],
  };
}

function toPr(p: GqlPr | GqlPrLite): PrSample {
  const reviews: ReviewSample[] = present(p.reviews?.nodes).map((r) => ({
    state: r.state,
    createdAt: r.createdAt,
    author: toActor(r.author),
    association: r.authorAssociation,
  }));
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    isDraft: p.isDraft,
    merged: p.merged,
    mergedAt: p.mergedAt ?? undefined,
    closedAt: p.closedAt ?? undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    mergeable: p.mergeable,
    author: toActor(p.author),
    association: p.authorAssociation,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    headRefName: p.headRefName,
    labels: present(p.labels?.nodes).map((l) => l.name),
    closingIssues: present(p.closingIssuesReferences?.nodes).map((n) => n.number),
    firstComments: present(p.firstComments?.nodes).map(toComment),
    lastComments: present("lastComments" in p ? p.lastComments?.nodes : undefined).map(toComment),
    reviews,
  };
}
