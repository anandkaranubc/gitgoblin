import type { GitHubSamples, IssueSample, PrSample, RepoMeta, ReviewSample } from "../github/types.ts";
import { type ForgeFetchOptions, actorOf, associationOf, commentOf, forgeJson, forgeList, referencedIssues } from "./common.ts";
import type { ForgeResult } from "./gitlab.ts";

interface GtUser { login: string; type?: string }
interface GtRepo {
  description: string; stars_count: number; forks_count: number; archived: boolean; has_issues: boolean; open_issues_count: number;
  open_pr_counter: number; default_branch: string; created_at: string; updated_at: string; fork: boolean; template: boolean; mirror: boolean;
  topics?: string[]; owner: GtUser; html_url: string; website?: string;
  /** Repository size in KiB. */
  size?: number;
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
interface GtComment { issue_url?: string; pull_request_url?: string; user: GtUser; body: string; created_at: string }
interface GtReview { state: string; submitted_at: string | null; user: GtUser | null }
interface GtLabel { name: string }

const REVIEW_STATE: Record<string, string> = { APPROVED: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };

/** Gitea / Forgejo REST v1 (Codeberg among them), unauthenticated. */
export async function fetchGitea(host: string, owner: string, name: string, options: ForgeFetchOptions): Promise<ForgeResult> {
  const base = `https://${host}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repo = await forgeJson<GtRepo>(base, options);
  // An SSO page or proxy can answer 200 with something else; fail clearly instead of mapping undefined fields.
  if (!repo || typeof repo !== "object" || typeof repo.created_at !== "string") throw new Error(`unexpected repository response from ${host}`);
  // The comments endpoint lists oldest first and ignores `limit` without `page` (Forgejo returned 13,529 comments,
  // 25 MB, in one call). A recent window read in a few pages keeps it small and current.
  const since = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();
  const commentPages = async (): Promise<GtComment[]> => {
    const all: GtComment[] = [];
    for (let page = 1; page <= 4; page++) {
      const batch = await forgeList<GtComment>(`${base}/issues/comments?since=${encodeURIComponent(since)}&page=${page}&limit=50`, options);
      all.push(...batch);
      if (batch.length < 50) break;
    }
    return all;
  };
  const [openIssues, closedIssues, openPulls, closedPulls, labels, comments] = await Promise.all([
    forgeList<GtIssue>(`${base}/issues?state=open&type=issues&sort=recentupdate&limit=50`, options),
    forgeList<GtIssue>(`${base}/issues?state=closed&type=issues&sort=recentupdate&limit=30`, options),
    forgeList<GtPull>(`${base}/pulls?state=open&sort=recentupdate&limit=30`, options),
    forgeList<GtPull>(`${base}/pulls?state=closed&sort=recentupdate&limit=50`, options),
    forgeList<GtLabel>(`${base}/labels?limit=100`, options),
    commentPages(),
  ]);

  const maintainers = new Set<string>();
  for (const p of closedPulls) if (p.merged_by?.login) maintainers.add(p.merged_by.login);
  if (repo.owner?.type !== "Organization" && repo.owner?.login) maintainers.add(repo.owner.login);

  const byIssue = new Map<number, GtComment[]>();
  for (const c of comments) {
    // Pull request comments carry pull_request_url and an empty issue_url.
    const n = Number((c.issue_url || c.pull_request_url || "").split("/").pop());
    if (Number.isInteger(n) && n > 0) byIssue.set(n, [...(byIssue.get(n) ?? []), c]);
  }
  // The window misses older threads; read the most recently active open items' comments individually (one call each).
  const missing = [...openIssues.filter((i) => !i.pull_request).slice(0, 15), ...openPulls.slice(0, 10)]
    .filter((i) => i.comments > 0 && (byIssue.get(i.number)?.length ?? 0) < i.comments);
  for (const item of missing) {
    const thread = await forgeList<GtComment>(`${base}/issues/${item.number}/comments?page=1&limit=50`, options);
    if (thread.length) byIssue.set(item.number, thread);
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
      commentsFetched: i.comments === 0 || all.length > 0,
    };
  };
  const reviewsFor = async (n: number): Promise<ReviewSample[]> =>
    forgeJson<GtReview[]>(`${base}/pulls/${n}/reviews?limit=10`, options)
      // Gitea names review states differently; analyzers read GitHub's names.
      .then((rs) => rs.filter((r) => r.user && r.submitted_at && REVIEW_STATE[r.state]).map((r) => ({ state: REVIEW_STATE[r.state]!, createdAt: r.submitted_at!, author: actorOf(r.user!.login), association: associationOf(r.user!.login, maintainers) })))
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
      commentsFetched: p.comments === 0 || all.length > 0 || reviews.has(p.number),
    };
  };

  const openSamples = openIssues.filter((i) => !i.pull_request).map(toIssue);
  const meta: RepoMeta = {
    owner, name, defaultBranch: repo.default_branch || "main", description: repo.description || undefined, homepage: repo.website || undefined,
    topics: repo.topics ?? [], stars: repo.stars_count, forks: repo.forks_count, watchers: 0, openIssuesAndPrs: repo.open_issues_count + repo.open_pr_counter,
    license: undefined, archived: repo.archived, disabled: false, isFork: repo.fork, isTemplate: repo.template, hasIssues: repo.has_issues,
    sizeKb: typeof repo.size === "number" && repo.size > 0 ? repo.size : 0, createdAt: repo.created_at, pushedAt: repo.updated_at,
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
