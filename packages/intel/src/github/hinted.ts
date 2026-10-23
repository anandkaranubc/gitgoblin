import type { GitHubApi } from "./client.ts";
import { type AuthorAssociation, type IssueSample, isBotLogin } from "./types.ts";

interface RestIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  state: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: { login: string; type: string } | null;
  author_association: AuthorAssociation;
  labels: { name: string }[];
  assignees: { login: string }[];
  comments: number;
  reactions?: { total_count: number };
  pull_request?: unknown;
}

interface RestComment {
  created_at: string;
  body: string;
  user: { login: string; type: string } | null;
  author_association: AuthorAssociation;
}

/**
 * Fetch open issues discovery pointed at that the GraphQL sample missed (two REST
 * calls each, so callers cap the count). Linked PRs are not available this way.
 */
export async function fetchHintedIssues(api: GitHubApi, owner: string, name: string, numbers: number[]): Promise<IssueSample[]> {
  const out: IssueSample[] = [];
  for (const n of numbers) {
    let issue: RestIssue;
    try {
      issue = await api.rest<RestIssue>(`/repos/${owner}/${name}/issues/${n}`);
    } catch {
      continue;
    }
    if (issue.state !== "open" || issue.pull_request) continue;
    let comments: RestComment[] = [];
    if (issue.comments > 0) {
      comments = await api.rest<RestComment[]>(`/repos/${owner}/${name}/issues/${n}/comments`, { per_page: 10 }).catch(() => []);
    }
    const toActor = (u: { login: string; type: string } | null) => (u ? { login: u.login, isBot: u.type === "Bot" || isBotLogin(u.login) } : undefined);
    const mapped = comments.map((c) => ({ createdAt: c.created_at, author: toActor(c.user), association: c.author_association, body: c.body }));
    out.push({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      body: issue.body ?? "",
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at ?? undefined,
      locked: issue.locked,
      author: toActor(issue.user),
      association: issue.author_association,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
      reactions: issue.reactions?.total_count ?? 0,
      commentCount: issue.comments,
      firstComments: mapped.slice(0, 3).map(({ body: _b, ...rest }) => ({ ...rest, body: undefined })),
      lastComments: mapped.slice(-6),
      linkedPrs: [],
    });
  }
  return out;
}
