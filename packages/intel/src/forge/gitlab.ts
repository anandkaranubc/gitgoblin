import type { FailedJob, GitHubSamples, IssueSample, PrSample, RepoMeta, WorkflowRun } from "../github/types.ts";
import { type ForgeFetchOptions, actorOf, associationOf, commentOf, forgeJson, referencedIssues } from "./common.ts";

interface GlUser { username: string }
interface GlProject {
  default_branch: string | null; description: string | null; star_count: number; forks_count: number; archived?: boolean;
  topics?: string[]; created_at: string; last_activity_at: string; license?: { nickname?: string; key?: string } | null;
  namespace?: { kind: string; path: string }; open_issues_count?: number; issues_enabled?: boolean; web_url: string;
}
interface GlIssue {
  iid: number; title: string; description: string | null; state: string; created_at: string; updated_at: string; closed_at: string | null;
  labels: string[]; assignees: GlUser[]; author: GlUser; closed_by: GlUser | null; user_notes_count: number; upvotes: number;
  merge_requests_count: number; discussion_locked: boolean | null; web_url: string;
}
interface GlMr {
  iid: number; title: string; description?: string | null; state: "opened" | "closed" | "merged" | "locked"; created_at: string; updated_at: string; merged_at: string | null;
  closed_at: string | null; merged_by: GlUser | null; author: GlUser; source_branch: string; labels: string[]; draft: boolean;
  has_conflicts?: boolean; changes_count?: string | null; user_notes_count: number; web_url: string;
}
interface GlNote { author: GlUser; body: string; created_at: string; system: boolean }
interface GlLabel { name: string; open_issues_count?: number }

export interface ForgeResult {
  meta: RepoMeta;
  samples: GitHubSamples;
  /** Recent pipelines on the default branch, when the forge exposes them. */
  runs?: WorkflowRun[];
  /** Failed jobs of a run, when the forge exposes them. */
  failedJobs?: (runId: number) => Promise<FailedJob[]>;
}

interface GlPipeline { id: number; status: string; ref: string; sha: string; source: string; updated_at: string; web_url: string }
interface GlJob { id: number; name: string; stage: string; status: string; web_url: string }

/** GitLab pipelines on a branch mapped to the CI-run shape the health analyzer reads. */
export async function fetchGitLabPipelines(base: string, ref: string, options: ForgeFetchOptions): Promise<WorkflowRun[]> {
  const pipelines = await forgeJson<GlPipeline[]>(`${base}/pipelines?ref=${encodeURIComponent(ref)}&per_page=40&order_by=updated_at&sort=desc`, options).catch(() => [] as GlPipeline[]);
  if (!Array.isArray(pipelines)) return [];
  return pipelines
    .filter((p) => ["push", "schedule", "web", "api", "trigger"].includes(p.source) && ["success", "failed", "canceled"].includes(p.status))
    .map((p) => ({ id: p.id, name: "GitLab CI", path: ".gitlab-ci.yml", workflowId: 1, event: p.source === "web" ? "workflow_dispatch" : p.source, conclusion: p.status === "failed" ? "failure" : p.status === "canceled" ? "cancelled" : "success", headSha: p.sha, updatedAt: p.updated_at, attempt: 1, url: p.web_url }));
}

/** GitLab REST v4, unauthenticated: issues, merge requests, labels and notes for a public project. */
export async function fetchGitLab(host: string, owner: string, name: string, options: ForgeFetchOptions): Promise<ForgeResult> {
  const base = `https://${host}/api/v4/projects/${encodeURIComponent(`${owner}/${name}`)}`;
  const project = await forgeJson<GlProject>(base, options);
  const [openIssues, closedIssues, openMrs, mergedMrs, closedMrs, labels] = await Promise.all([
    forgeJson<GlIssue[]>(`${base}/issues?state=opened&order_by=updated_at&per_page=50`, options).catch(() => [] as GlIssue[]),
    forgeJson<GlIssue[]>(`${base}/issues?state=closed&order_by=updated_at&per_page=30`, options).catch(() => [] as GlIssue[]),
    forgeJson<GlMr[]>(`${base}/merge_requests?state=opened&order_by=updated_at&per_page=30`, options).catch(() => [] as GlMr[]),
    forgeJson<GlMr[]>(`${base}/merge_requests?state=merged&order_by=updated_at&per_page=30`, options).catch(() => [] as GlMr[]),
    forgeJson<GlMr[]>(`${base}/merge_requests?state=closed&order_by=updated_at&per_page=30`, options).catch(() => [] as GlMr[]),
    forgeJson<GlLabel[]>(`${base}/labels?per_page=100`, options).catch(() => [] as GlLabel[]),
  ]);

  const maintainers = new Set<string>();
  for (const mr of mergedMrs) if (mr.merged_by?.username) maintainers.add(mr.merged_by.username);
  for (const issue of closedIssues) if (issue.closed_by?.username) maintainers.add(issue.closed_by.username);
  if (project.namespace?.kind === "user" && project.namespace.path) maintainers.add(project.namespace.path);

  // Notes cost one call each; take them for the most recently active open items only.
  const notesFor = async (kind: "issues" | "merge_requests", iid: number) =>
    forgeJson<GlNote[]>(`${base}/${kind}/${iid}/notes?sort=asc&order_by=created_at&per_page=20`, options).then((n) => n.filter((x) => !x.system)).catch(() => [] as GlNote[]);
  const issueNotes = new Map<number, GlNote[]>();
  for (const issue of openIssues.slice(0, 15)) if (issue.user_notes_count > 0) issueNotes.set(issue.iid, await notesFor("issues", issue.iid));
  // Merge requests that mention an issue tell us whether someone is already on it.
  const relatedMrs = new Map<number, GlMr[]>();
  for (const issue of openIssues.slice(0, 15)) {
    if (issue.merge_requests_count > 0) relatedMrs.set(issue.iid, await forgeJson<GlMr[]>(`${base}/issues/${issue.iid}/related_merge_requests?per_page=10`, options).catch(() => [] as GlMr[]));
  }
  const mrNotes = new Map<number, GlNote[]>();
  for (const mr of openMrs.slice(0, 10)) if (mr.user_notes_count > 0) mrNotes.set(mr.iid, await notesFor("merge_requests", mr.iid));

  const mrsByIssue = new Map<number, GlMr[]>();
  for (const m of [...openMrs, ...mergedMrs, ...closedMrs]) for (const n of referencedIssues(m.description)) mrsByIssue.set(n, [...(mrsByIssue.get(n) ?? []), m]);
  const toLinked = (m: GlMr) => ({ number: m.iid, url: m.web_url, state: m.state === "merged" ? "MERGED" as const : m.state === "opened" || m.state === "locked" ? "OPEN" as const : "CLOSED" as const, isDraft: m.draft, updatedAt: m.updated_at });
  const toIssue = (i: GlIssue): IssueSample => {
    const notes = issueNotes.get(i.iid) ?? [];
    const comments = notes.map((n) => commentOf(n.author.username, n.created_at, n.body, maintainers));
    return {
      number: i.iid, title: i.title, url: i.web_url, body: i.description ?? "", createdAt: i.created_at, updatedAt: i.updated_at,
      closedAt: i.closed_at ?? undefined, locked: Boolean(i.discussion_locked), author: actorOf(i.author?.username),
      association: associationOf(i.author?.username, maintainers), labels: i.labels, assignees: i.assignees.map((a) => a.username),
      reactions: i.upvotes, commentCount: i.user_notes_count, firstComments: comments.slice(0, 3).map((c) => ({ ...c, body: undefined })),
      lastComments: comments.slice(-6),
      linkedPrs: [...new Map([...(relatedMrs.get(i.iid) ?? []), ...(mrsByIssue.get(i.iid) ?? [])].map((m) => [m.iid, toLinked(m)])).values()],
    };
  };
  const toPr = (m: GlMr): PrSample => {
    const notes = mrNotes.get(m.iid) ?? [];
    const comments = notes.map((n) => commentOf(n.author.username, n.created_at, n.body, maintainers));
    return {
      number: m.iid, title: m.title, url: m.web_url, state: m.state === "merged" ? "MERGED" : m.state === "opened" || m.state === "locked" ? "OPEN" : "CLOSED",
      isDraft: m.draft, merged: m.state === "merged", mergedAt: m.merged_at ?? undefined, closedAt: m.closed_at ?? undefined,
      createdAt: m.created_at, updatedAt: m.updated_at, mergeable: m.has_conflicts === true ? "CONFLICTING" : m.has_conflicts === false ? "MERGEABLE" : "UNKNOWN",
      author: actorOf(m.author?.username), association: associationOf(m.author?.username, maintainers), additions: 0, deletions: 0,
      changedFiles: Number(m.changes_count ?? 0) || 0, headRefName: m.source_branch, labels: m.labels, closingIssues: referencedIssues(m.description),
      firstComments: comments.slice(0, 3).map((c) => ({ ...c, body: undefined })), lastComments: comments.slice(-5), reviews: [],
    };
  };

  const openSamples = openIssues.map(toIssue);
  const meta: RepoMeta = {
    owner, name, defaultBranch: project.default_branch ?? "main", description: project.description ?? undefined, homepage: undefined,
    topics: project.topics ?? [], stars: project.star_count, forks: project.forks_count, watchers: 0,
    openIssuesAndPrs: (project.open_issues_count ?? openIssues.length) + openMrs.length, license: project.license?.nickname ?? project.license?.key ?? undefined,
    archived: project.archived ?? false, disabled: false, isFork: false, isTemplate: false, hasIssues: project.issues_enabled ?? (openIssues.length > 0 || closedIssues.length > 0),
    sizeKb: 0, createdAt: project.created_at, pushedAt: project.last_activity_at,
  };
  const samples: GitHubSamples = {
    isMirror: false,
    openIssueCount: project.open_issues_count ?? openIssues.length,
    openPrCount: openMrs.length,
    labels: labels.map((l) => ({ name: l.name, openIssues: l.open_issues_count ?? openSamples.filter((i) => i.labels.includes(l.name)).length })),
    openIssues: openSamples,
    closedIssues: closedIssues.map(toIssue),
    openPrs: openMrs.map(toPr),
    closedPrs: [...mergedMrs, ...closedMrs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(toPr),
  };
  const runs = await fetchGitLabPipelines(base, meta.defaultBranch, options);
  const failedJobs = async (runId: number): Promise<FailedJob[]> =>
    forgeJson<GlJob[]>(`${base}/pipelines/${runId}/jobs?scope[]=failed&per_page=20`, options)
      .then((jobs) => jobs.map((j) => ({ name: `${j.stage}: ${j.name}`, url: j.web_url, failedSteps: [] })))
      .catch(() => [] as FailedJob[]);
  return { meta, samples, runs, failedJobs };
}
