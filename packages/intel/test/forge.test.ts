import { describe, expect, it } from "vitest";
import { knownForge, referencedIssues } from "../src/forge/common.ts";
import { fetchGitea } from "../src/forge/gitea.ts";
import { fetchGitLab } from "../src/forge/gitlab.ts";

function fakeFetch(routes: Record<string, unknown>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("referencedIssues", () => {
  it("reads the issues a pull request says it fixes", () => {
    expect(referencedIssues("Fixes #12 and closes #7. See #12 again. Related to #99")).toEqual([12, 7, 99]);
    expect(referencedIssues("Bump version to 1.2.3")).toEqual([]);
    expect(referencedIssues(null)).toEqual([]);
  });
});

describe("forge detection", () => {
  it("knows the common hosts", () => {
    expect(knownForge("gitlab.com")).toBe("gitlab");
    expect(knownForge("gitlab.freedesktop.org")).toBe("gitlab");
    expect(knownForge("codeberg.org")).toBe("gitea");
    expect(knownForge("example.com")).toBeUndefined();
  });
});

describe("fetchGitLab", () => {
  it("maps project, issues, merge requests and notes; maintainers are mergers and closers", async () => {
    const fetchImpl = fakeFetch({
      "/projects/o%2Fr/issues?state=opened": [{ iid: 7, title: "Crash", description: "boom", state: "opened", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", closed_at: null, labels: ["bug"], assignees: [], author: { username: "ext" }, closed_by: null, user_notes_count: 1, upvotes: 2, merge_requests_count: 1, discussion_locked: null, web_url: "https://gitlab.com/o/r/-/issues/7" }],
      "/projects/o%2Fr/issues?state=closed": [{ iid: 3, title: "Old", description: "", state: "closed", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", closed_at: "2025-02-01T00:00:00Z", labels: [], assignees: [], author: { username: "someone" }, closed_by: { username: "maint" }, user_notes_count: 0, upvotes: 0, merge_requests_count: 0, discussion_locked: null, web_url: "u3" }],
      "/merge_requests?state=opened": [],
      "/merge_requests?state=merged": [{ iid: 9, title: "Fix", state: "merged", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-05T00:00:00Z", merged_at: "2026-01-05T00:00:00Z", closed_at: null, merged_by: { username: "maint" }, author: { username: "ext" }, source_branch: "fix", labels: [], draft: false, user_notes_count: 0, web_url: "u9" }],
      "/merge_requests?state=closed": [],
      "/labels": [{ name: "bug" }],
      "/pipelines?ref=main": [{ id: 1, status: "failed", ref: "main", sha: "abc", source: "push", updated_at: "2026-02-01T00:00:00Z", web_url: "pipe1" }, { id: 2, status: "success", ref: "main", sha: "abd", source: "merge_request_event", updated_at: "2026-01-01T00:00:00Z", web_url: "pipe2" }],
      "/pipelines/1/jobs": [{ id: 10, name: "unit", stage: "test", status: "failed", web_url: "job10" }],
      "/issues/7/related_merge_requests": [{ iid: 12, title: "WIP fix", state: "opened", created_at: "2026-01-20T00:00:00Z", updated_at: "2026-01-25T00:00:00Z", merged_at: null, closed_at: null, merged_by: null, author: { username: "ext" }, source_branch: "fix7", labels: [], draft: true, user_notes_count: 0, web_url: "https://gitlab.com/o/r/-/merge_requests/12" }],
      "/issues/7/notes": [{ author: { username: "maint" }, body: "confirmed", created_at: "2026-01-02T00:00:00Z", system: false }, { author: { username: "bot" }, body: "changed label", created_at: "2026-01-02T00:00:00Z", system: true }],
      "/projects/o%2Fr": { default_branch: "main", description: "d", star_count: 10, forks_count: 2, created_at: "2020-01-01T00:00:00Z", last_activity_at: "2026-02-01T00:00:00Z", namespace: { kind: "group", path: "o" }, web_url: "https://gitlab.com/o/r" },
    });
    const { meta, samples, runs, failedJobs } = await fetchGitLab("gitlab.com", "o", "r", { fetchImpl, counter: { requests: 0 } });
    expect(meta).toMatchObject({ defaultBranch: "main", stars: 10, hasIssues: true });
    expect(runs).toEqual([{ id: 1, name: "GitLab CI", path: ".gitlab-ci.yml", workflowId: 1, event: "push", conclusion: "failure", headSha: "abc", updatedAt: "2026-02-01T00:00:00Z", attempt: 1, url: "pipe1" }]);
    expect(await failedJobs!(1)).toEqual([{ name: "test: unit", url: "job10", failedSteps: [] }]);
    expect(samples.openIssues[0]).toMatchObject({ number: 7, association: "NONE", labels: ["bug"], reactions: 2 });
    expect(samples.openIssues[0]?.linkedPrs).toEqual([{ number: 12, url: "https://gitlab.com/o/r/-/merge_requests/12", state: "OPEN", isDraft: true, updatedAt: "2026-01-25T00:00:00Z" }]);
    expect(samples.openIssues[0]?.lastComments).toEqual([{ createdAt: "2026-01-02T00:00:00Z", author: { login: "maint", isBot: false }, association: "MEMBER", body: "confirmed" }]);
    expect(samples.closedPrs[0]).toMatchObject({ number: 9, state: "MERGED", merged: true, association: "NONE" });
    expect(samples.labels).toEqual([{ name: "bug", openIssues: 1 }]);
  });
});

describe("fetchGitea", () => {
  it("maps repository, issues, pulls, reviews and repo-wide comments", async () => {
    const fetchImpl = fakeFetch({
      "/repos/o/r/issues?state=open": [{ number: 5, title: "Hang", body: "x", state: "open", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", closed_at: null, labels: [{ name: "bug" }], assignees: null, user: { login: "u" }, comments: 1, is_locked: false, html_url: "https://codeberg.org/o/r/issues/5" }],
      "/repos/o/r/issues?state=closed": [],
      "/repos/o/r/pulls?state=open": [{ number: 8, title: "PR", body: "Fixes #5", state: "open", draft: false, merged: false, merged_at: null, closed_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", mergeable: false, user: { login: "u" }, merged_by: null, additions: 3, deletions: 1, changed_files: 1, head: { ref: "topic" }, labels: [], comments: 0, html_url: "p8" }],
      "/repos/o/r/pulls?state=closed": [{ number: 6, title: "Done", state: "closed", draft: false, merged: true, merged_at: "2026-01-03T00:00:00Z", closed_at: "2026-01-03T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-03T00:00:00Z", mergeable: true, user: { login: "u" }, merged_by: { login: "owner" }, head: { ref: "f" }, labels: [], comments: 0, html_url: "p6" }],
      "/repos/o/r/labels": [{ name: "bug" }],
      "/repos/o/r/issues/comments?since": [{ issue_url: "https://codeberg.org/api/v1/repos/o/r/issues/5", user: { login: "owner" }, body: "can reproduce", created_at: "2026-01-02T00:00:00Z" }],
      "/repos/o/r/pulls/8/reviews": [{ state: "REQUEST_CHANGES", submitted_at: "2026-01-02T00:00:00Z", user: { login: "owner" } }],
      "/repos/o/r": { description: "d", stars_count: 100, forks_count: 5, archived: false, has_issues: true, open_issues_count: 1, open_pr_counter: 1, default_branch: "master", created_at: "2019-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", fork: false, template: false, mirror: false, topics: ["terminal"], owner: { login: "owner", type: "User" }, html_url: "https://codeberg.org/o/r" },
    });
    const { meta, samples } = await fetchGitea("codeberg.org", "o", "r", { fetchImpl, counter: { requests: 0 } });
    expect(meta).toMatchObject({ defaultBranch: "master", stars: 100, topics: ["terminal"], hasIssues: true });
    expect(samples.openIssues[0]?.lastComments[0]).toMatchObject({ association: "MEMBER", body: "can reproduce" });
    expect(samples.openIssues[0]?.linkedPrs).toEqual([{ number: 8, url: "p8", state: "OPEN", isDraft: false, updatedAt: "2026-01-02T00:00:00Z" }]);
    expect(samples.openPrs[0]?.closingIssues).toEqual([5]);
    expect(samples.openPrs[0]).toMatchObject({ mergeable: "CONFLICTING", reviews: [{ state: "REQUEST_CHANGES", association: "MEMBER" }] });
    expect(samples.closedPrs[0]).toMatchObject({ state: "MERGED", association: "NONE" });
  });
});
