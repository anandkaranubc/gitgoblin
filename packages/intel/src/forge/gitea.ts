import type { GitHubSamples, IssueSample, PrSample, RepoMeta, ReviewSample } from "../github/types.ts";
import { type ForgeFetchOptions, actorOf, associationOf, commentOf, forgeJson, referencedIssues } from "./common.ts";
import type { ForgeResult } from "./gitlab.ts";

interface GtUser { login: string; type?: string }
interface GtRepo {
  description: string; stars_count: number; forks_count: number; archived: boolean; has_issues: boolean; open_issues_count: number;
  open_pr_counter: number; default_branch: string; created_at: string; updated_at: string; fork: boolean; template: boolean; mirror: boolean;
  topics?: string[]; owner: GtUser; html_url: string; website?: string;
}
interface GtIssue {
  number: number; title: string; body: string | null; state: string; created_at: string; updated_at: string; closed_at: string | null;
  labels: { name: string }[]; assignees: GtUser[] | null; user: GtUser; comments: number; is_locked: boolean; html_url: string; pull_request?: unknown;
}
interface GtPull {
  number: number; title: string; body?: string | null; state: "open" | "closed"; draft: boolean; merged: boolean; merged_at: string | null; closed_at: string | null;
  created_at: string; updated_at: string; mergeable: boolean; user: GtUser; merged_by: GtUser | null; additions?: number; deletions?: number;
  changed_files?: number; head: { ref: string }; labels: { name: string }[]; comments: number; html_url: string;
}
interface GtComment { issue_url: string; user: GtUser; body: string; created_at: string }
interface GtReview { state: string; submitted_at: string | null; user: GtUser | null }
interface GtLabel { name: string }

/** Gitea / Forgejo REST v1 (Codeberg among them), unauthenticated. */
export async function fetchGitea(host: string, owner: string, name: string, options: ForgeFetchOptions): Promise<ForgeResult> {
  const base = `https://${host}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repo = await forgeJson<GtRepo>(base, options);
  const since = new Date(Date.now() - 365 * 24 * 3_600_000).toISOString();
  const [openIssues, closedIssues, openPulls, closedPulls, labels, comments] = await Promise.all([
    forgeJson<GtIssue[]>(`${base}/issues?state=open&type=issues&sort=recentupdate&limit=50`, options).catch(() => [] as GtIssue[]),
    forgeJson<GtIssue[]>(`${base}/issues?state=closed&type=issues&sort=recentupdate&limit=30`, options).catch(() => [] as GtIssue[]),
    forgeJson<GtPull[]>(`${base}/pulls?state=open&sort=recentupdate&limit=30`, options).catch(() => [] as GtPull[]),
    forgeJson<GtPull[]>(`${base}/pulls?state=closed&sort=recentupdate&limit=50`, options).catch(() => [] as GtPull[]),
    forgeJson<GtLabel[]>(`${base}/labels?limit=100`, options).catch(() => [] as GtLabel[]),
    // One call returns recent comments across all issues and pull requests, oldest first.
    forgeJson<GtComment[]>(`${base}/issues/comments?since=${encodeURIComponent(since)}&limit=100`, options).catch(() => [] as GtComment[]),
  ]);

  const maintainers = new Set<string>();
  for (const p of closedPulls) if (p.merged_by?.login) maintainers.add(p.merged_by.login);
  if (repo.owner?.type !== "Organization" && repo.owner?.login) maintainers.add(repo.owner.login);

  const byIssue = new Map<number, GtComment[]>();
  for (const c of comments) {
    const n = Number(c.issue_url.split("/").pop());
    if (!Number.isNaN(n)) byIssue.set(n, [...(byIssue.get(n) ?? []), c]);
  }
  const commentsFor = (n: number) => (byIssue.get(n) ?? []).map((c) => commentOf(c.user?.login, c.created_at, c.body, maintainers));
  // No cross-reference API here; pull request descriptions saying "fixes #N" are the link.
  const prsByIssue = new Map<number, GtPull[]>();
  for (const p of [...openPulls, ...closedPulls]) for (const n of referencedIssues(p.body)) prsByIssue.set(n, [...(prsByIssue.get(n) ?? []), p]);
  const linkedFor = (n: number) => (prsByIssue.get(n) ?? []).map((p) => ({ number: p.number, url: p.html_url, state: p.merged ? "MERGED" as const : p.state === "open" ? "OPEN" as const : "CLOSED" as const, isDraft: p.draft, updatedAt: p.updated_at }));

  const toIssue = (i: GtIssue): IssueSample => {
    const all = commentsFor(i.number);
    return {
      number: i.number, title: i.title, url: i.html_url, body: i.body ?? "", createdAt: i.created_at, updatedAt: i.updated_at,
      closedAt: i.closed_at ?? undefined, locked: i.is_locked, author: actorOf(i.user?.login), association: associationOf(i.user?.login, maintainers),
      labels: i.labels.map((l) => l.name), assignees: (i.assignees ?? []).map((a) => a.login), reactions: 0, commentCount: i.comments,
      firstComments: all.slice(0, 3).map((c) => ({ ...c, body: undefined })), lastComments: all.slice(-6), linkedPrs: linkedFor(i.number),
    };
  };
  const reviewsFor = async (n: number): Promise<ReviewSample[]> =>
    forgeJson<GtReview[]>(`${base}/pulls/${n}/reviews?limit=10`, options)
      .then((rs) => rs.filter((r) => r.user && r.submitted_at && /APPROVED|REQUEST_CHANGES|COMMENT/.test(r.state)).map((r) => ({ state: r.state, createdAt: r.submitted_at!, author: actorOf(r.user!.login), association: associationOf(r.user!.login, maintainers) })))
      .catch(() => [] as ReviewSample[]);
  const reviews = new Map<number, ReviewSample[]>();
  for (const p of openPulls.slice(0, 10)) reviews.set(p.number, await reviewsFor(p.number));

  const toPr = (p: GtPull): PrSample => {
    const all = commentsFor(p.number);
    return {
      number: p.number, title: p.title, url: p.html_url, state: p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED", isDraft: p.draft,
      merged: p.merged, mergedAt: p.merged_at ?? undefined, closedAt: p.closed_at ?? undefined, createdAt: p.created_at, updatedAt: p.updated_at,
      mergeable: p.state === "open" ? (p.mergeable ? "MERGEABLE" : "CONFLICTING") : "UNKNOWN", author: actorOf(p.user?.login),
      association: associationOf(p.user?.login, maintainers), additions: p.additions ?? 0, deletions: p.deletions ?? 0, changedFiles: p.changed_files ?? 0,
      headRefName: p.head?.ref ?? "", labels: p.labels.map((l) => l.name), closingIssues: referencedIssues(p.body), firstComments: all.slice(0, 3).map((c) => ({ ...c, body: undefined })),
      lastComments: all.slice(-5), reviews: reviews.get(p.number) ?? [],
    };
  };

  const openSamples = openIssues.filter((i) => !i.pull_request).map(toIssue);
  const meta: RepoMeta = {
    owner, name, defaultBranch: repo.default_branch || "main", description: repo.description || undefined, homepage: repo.website || undefined,
    topics: repo.topics ?? [], stars: repo.stars_count, forks: repo.forks_count, watchers: 0, openIssuesAndPrs: repo.open_issues_count + repo.open_pr_counter,
    license: undefined, archived: repo.archived, disabled: false, isFork: repo.fork, isTemplate: repo.template, hasIssues: repo.has_issues,
    sizeKb: 0, createdAt: repo.created_at, pushedAt: repo.updated_at,
  };
  const samples: GitHubSamples = {
    isMirror: repo.mirror,
    openIssueCount: repo.open_issues_count,
    openPrCount: repo.open_pr_counter,
    labels: labels.map((l) => ({ name: l.name, openIssues: openSamples.filter((i) => i.labels.includes(l.name)).length })),
    openIssues: openSamples,
    closedIssues: closedIssues.filter((i) => !i.pull_request).map(toIssue),
    openPrs: openPulls.map(toPr),
    closedPrs: closedPulls.map(toPr),
  };
  return { meta, samples };
}
