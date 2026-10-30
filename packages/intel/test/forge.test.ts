import { describe, expect, it } from "vitest";
import { knownForge, referencedIssues } from "../src/forge/common.ts";
import { fetchGitea } from "../src/forge/gitea.ts";
import { fetchGitLab } from "../src/forge/gitlab.ts";
import { assessIssue } from "../src/analyzers/issues.ts";

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
    expect(referencedIssues("Fixes #12 and closes #7. See #12 again. Related to #99")).toEqual([12, 7]);
    // A mention is not a fix: "see #45 for background" must not mark #45 resolved when the PR merges.
    expect(referencedIssues("See #45 for background; refs #46; addresses #47")).toEqual([]);
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

describe("GitLab merge requests that could not be read", () => {
  it("keeps an issue with merge requests from looking untouched when their lookup fails", async () => {
    const fetchImpl = fakeFetch({
      "/projects/o%2Fr/issues?state=opened": [{ iid: 4, title: "Crash on empty input", description: "It crashes when the input is empty.", state: "opened", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", closed_at: null, labels: ["bug"], assignees: [], author: { username: "ext" }, closed_by: null, user_notes_count: 0, upvotes: 0, merge_requests_count: 2, discussion_locked: null, web_url: "https://gitlab.com/o/r/-/issues/4" }],
      "/projects/o%2Fr/issues?state=closed": [],
      "/merge_requests?state=": [],
      "/labels": [],
      "/pipelines?ref=main": [],
      // No route for /issues/4/related_merge_requests: the lookup fails.
      "/projects/o%2Fr": { default_branch: "main", description: "d", star_count: 10, forks_count: 2, created_at: "2020-01-01T00:00:00Z", last_activity_at: "2026-02-01T00:00:00Z", namespace: { kind: "group", path: "o" }, web_url: "https://gitlab.com/o/r" },
    });
    const failures: string[] = [];
    const { samples } = await fetchGitLab("gitlab.com", "o", "r", { fetchImpl, counter: { requests: 0 }, failures });
    const issue = samples.openIssues[0]!;
    expect(issue).toMatchObject({ linkedPrs: [], unreadLinkedPrs: 2 });
    expect(failures.some((f) => f.includes("related_merge_requests"))).toBe(true);
    const a = assessIssue(issue, new Date("2026-02-15T00:00:00Z"), true, "https://gitlab.com/o/r");
    expect(a.novelty).toBe(0.5);
    expect(a.noveltyReason).toMatch(/2 merge requests for it that could not be read/);
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
      "/repos/o/r": { description: "d", stars_count: 100, forks_count: 5, archived: false, has_issues: true, open_issues_count: 1, open_pr_counter: 1, default_branch: "master", created_at: "2019-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", fork: false, template: false, mirror: false, topics: ["terminal"], owner: { login: "owner", type: "User" }, html_url: "https://codeberg.org/o/r", size: 2048 },
    });
    const { meta, samples } = await fetchGitea("codeberg.org", "o", "r", { fetchImpl, counter: { requests: 0 } });
    // Gitea reports the size in KiB, which the shallow-clone rule for large repositories reads.
    expect(meta).toMatchObject({ defaultBranch: "master", stars: 100, topics: ["terminal"], hasIssues: true, sizeKb: 2048 });
    expect(samples.openIssues[0]?.lastComments[0]).toMatchObject({ association: "MEMBER", body: "can reproduce" });
    expect(samples.openIssues[0]?.linkedPrs).toEqual([{ number: 8, url: "p8", state: "OPEN", isDraft: false, updatedAt: "2026-01-02T00:00:00Z" }]);
    expect(samples.openPrs[0]?.closingIssues).toEqual([5]);
    // Gitea's REQUEST_CHANGES is GitHub's CHANGES_REQUESTED, the name the stale-PR analyzer reads.
    expect(samples.openPrs[0]).toMatchObject({ mergeable: "CONFLICTING", reviews: [{ state: "CHANGES_REQUESTED", association: "MEMBER" }] });
    expect(samples.closedPrs[0]).toMatchObject({ state: "MERGED", association: "NONE" });
  });
});

describe("forges that hide comments without a token", () => {
  it("stops after the first refused notes request and marks comments as unread, not absent", async () => {
    const calls: string[] = [];
    const issue = (iid: number) => ({ iid, title: `Bug ${iid}`, description: "boom", state: "opened", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", closed_at: null, labels: [], assignees: [], author: { username: "ext" }, closed_by: null, user_notes_count: 7, upvotes: 0, merge_requests_count: 0, discussion_locked: null, web_url: `u${iid}` });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/notes")) return new Response('{"message":"401 Unauthorized"}', { status: 401 });
      if (url.includes("/issues?state=opened")) return Response.json([issue(1), issue(2), issue(3)]);
      if (url.includes("/issues?state=closed")) return Response.json([{ ...issue(9), state: "closed", closed_by: { username: "ext" }, user_notes_count: 0 }]);
      if (/\/projects\/o%2Fr$/.test(url)) return Response.json({ default_branch: "main", description: "d", star_count: 1, forks_count: 0, created_at: "2020-01-01T00:00:00Z", last_activity_at: "2026-02-01T00:00:00Z", web_url: "w" });
      return Response.json([]);
    }) as typeof fetch;
    const { samples, notes } = await fetchGitLab("gitlab.com", "o", "r", { fetchImpl, counter: { requests: 0 } });
    expect(calls.filter((u) => u.includes("/notes"))).toHaveLength(1);
    expect(samples.openIssues.map((i) => i.commentsFetched)).toEqual([false, false, false]);
    expect(notes?.join(" ")).toMatch(/does not show issue and merge request comments without a token/);
    expect(notes?.join(" ")).toMatch(/whether the project is archived/);
    // ext closed their own issue: that does not make them a maintainer.
    expect(samples.openIssues[0]?.association).toBe("NONE");
  });

  it("recognises self-hosted GitLab by the 401 its version endpoint returns", async () => {
    const { detectForge } = await import("../src/forge/index.ts");
    const fetchImpl = (async (input: string | URL | Request) => (String(input).includes("/api/v4/version") ? new Response('{"message":"401 Unauthorized"}', { status: 401 }) : new Response("nope", { status: 404 }))) as typeof fetch;
    expect(await detectForge("salsa.debian.org", { fetchImpl })).toBe("gitlab");
  });

  it("files Gitea pull request comments under their pull request", async () => {
    const fetchImpl = fakeFetch({
      "/repos/o/r/pulls?state=open": [{ number: 8, title: "PR", body: "", state: "open", draft: false, merged: false, merged_at: null, closed_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", mergeable: true, user: { login: "ext" }, merged_by: null, head: { ref: "b" }, labels: [], comments: 1, html_url: "p8" }],
      "/repos/o/r/issues/comments?since": [{ issue_url: "", pull_request_url: "https://codeberg.org/o/r/pulls/8", user: { login: "owner" }, body: "please rebase", created_at: "2026-01-02T00:00:00Z" }],
      "/repos/o/r": { description: "", stars_count: 0, forks_count: 0, archived: false, has_issues: true, open_issues_count: 0, open_pr_counter: 1, default_branch: "main", created_at: "2020-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", fork: false, template: false, mirror: false, owner: { login: "owner" }, html_url: "h" },
    });
    const { samples } = await fetchGitea("codeberg.org", "o", "r", { fetchImpl, counter: { requests: 0 } });
    expect(samples.openPrs[0]?.lastComments.map((c) => c.body)).toEqual(["please rebase"]);
    expect(fetchImpl.calls.find((u) => u.includes("issues/comments"))).toMatch(/page=1&limit=50/);
  });

  it("counts a Gitea thread as read only when every comment was", async () => {
    const issue = (n: number, comments: number) => ({ number: n, title: `Crash ${n}`, body: "x", state: "open", created_at: "2026-06-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", closed_at: null, labels: [], assignees: null, user: { login: "reporter" }, comments, is_locked: false, html_url: `h${n}` });
    // Only the reporter's latest bump on #20 falls in the 90-day window; its four older replies were not read.
    const fetchImpl = fakeFetch({
      "/repos/o/r/issues?state=open": [...Array.from({ length: 15 }, (_, k) => issue(k + 1, 0)), issue(20, 5)],
      "/repos/o/r/pulls?state=open": [{ number: 8, title: "PR", body: "", state: "open", draft: false, merged: false, merged_at: null, closed_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", mergeable: true, user: { login: "ext" }, merged_by: null, head: { ref: "b" }, labels: [], comments: 2, html_url: "p8" }],
      "/repos/o/r/issues/comments?since": [
        { issue_url: "https://codeberg.org/api/v1/repos/o/r/issues/20", user: { login: "reporter" }, body: "any news?", created_at: "2026-10-01T00:00:00Z" },
        { issue_url: "", pull_request_url: "https://codeberg.org/o/r/pulls/8", user: { login: "owner" }, body: "please rebase", created_at: "2026-01-02T00:00:00Z" },
      ],
      // Gitea counts a review with a body as a comment on the pull request.
      "/repos/o/r/pulls/8/reviews": [{ state: "APPROVED", submitted_at: "2026-01-03T00:00:00Z", user: { login: "owner" } }],
      "/repos/o/r": { description: "", stars_count: 0, forks_count: 0, archived: false, has_issues: true, open_issues_count: 16, open_pr_counter: 1, default_branch: "main", created_at: "2020-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", fork: false, template: false, mirror: false, owner: { login: "owner" }, html_url: "h" },
    });
    const { samples } = await fetchGitea("codeberg.org", "o", "r", { fetchImpl, counter: { requests: 0 } });
    expect(samples.openIssues.find((i) => i.number === 20)).toMatchObject({ commentCount: 5, commentsFetched: false });
    expect(samples.openIssues.find((i) => i.number === 1)?.commentsFetched).toBe(true);
    expect(samples.openPrs[0]?.commentsFetched).toBe(true);
  });
});

describe("unread comments in profile statistics and triage", () => {
  it("leaves items whose comments were not read out of response times and triage", async () => {
    const { computeActivity } = await import("../src/profile/activity.ts");
    const { assessIssue } = await import("../src/analyzers/issues.ts");
    const now = new Date("2026-10-22T00:00:00Z");
    const pr = { number: 1, title: "x", url: "u", state: "MERGED", isDraft: false, merged: true, mergedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergeable: "UNKNOWN", author: { login: "ext", isBot: false }, association: "NONE", additions: 0, deletions: 0, changedFiles: 1, headRefName: "b", labels: [], closingIssues: [], firstComments: [], lastComments: [], reviews: [], commentsFetched: false };
    const samples = { isMirror: false, openIssueCount: 0, openPrCount: 0, labels: [], openIssues: [], closedIssues: [], openPrs: [], closedPrs: [pr] };
    const a = computeActivity({ commits: [], samples: samples as never, releases: [], pushedAt: undefined, openIssues: 0, openPrs: 0, now });
    expect(a.medianPrResponseHours).toBeUndefined();
    // Most issues unread: the readable ones are the unanswered ones, so the median would mislead.
    const unread = (n: number, fetched: boolean) => ({ number: n, title: "t", url: "u", body: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", locked: false, author: { login: "ext", isBot: false }, association: "NONE", labels: [], assignees: [], reactions: 0, commentCount: fetched ? 0 : 4, firstComments: [], lastComments: [], linkedPrs: [], commentsFetched: fetched });
    const issueSamples = { ...samples, closedPrs: [], openIssues: [unread(1, true), unread(2, false), unread(3, false), unread(4, false)] };
    expect(computeActivity({ commits: [], samples: issueSamples as never, releases: [], pushedAt: undefined, openIssues: 4, openPrs: 0, now }).medianIssueResponseHours).toBeUndefined();
    const issue = { number: 3, title: "Search ignores accents", url: "https://gitlab.com/o/r/-/issues/3", body: "Searching for cafe does not find café.", createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", locked: false, author: { login: "ext", isBot: false }, association: "NONE", labels: [], assignees: [], reactions: 0, commentCount: 7, firstComments: [], lastComments: [], linkedPrs: [], commentsFetched: false };
    expect(assessIssue(issue as never, now, true, "https://gitlab.com/o/r").kind).not.toBe("triage");
  });
});

describe("forge requests against a hostile or flaky host", () => {
  it("follows redirects only to https on the same host", async () => {
    const { forgeJson } = await import("../src/forge/common.ts");
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://forge.test/api/v1/version") return new Response(null, { status: 302, headers: { location: "/api/v1/version2" } });
      if (url === "https://forge.test/api/v1/version2") return Response.json({ version: "1" });
      if (url === "https://forge.test/api/v1/evil") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    expect(await forgeJson("https://forge.test/api/v1/version", { fetchImpl, counter: { requests: 0 } })).toEqual({ version: "1" });
    await expect(forgeJson("https://forge.test/api/v1/evil", { fetchImpl, counter: { requests: 0 } })).rejects.toThrow(/redirect .* refused/);
    expect(calls).not.toContain("http://169.254.169.254/latest");
  });

  it("refuses oversized answers and records failed list endpoints", async () => {
    const { forgeJson, forgeList, MAX_FORGE_BODY } = await import("../src/forge/common.ts");
    const big = (async () => new Response("[]", { status: 200, headers: { "content-length": String(MAX_FORGE_BODY + 1) } })) as typeof fetch;
    await expect(forgeJson("https://forge.test/api/v1/repos/o/r/issues", { fetchImpl: big, counter: { requests: 0 } })).rejects.toThrow(/over the/);
    const failures: string[] = [];
    const flaky = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    expect(await forgeList("https://forge.test/api/v1/repos/o/r/pulls?state=closed", { fetchImpl: flaky, counter: { requests: 0 }, failures })).toEqual([]);
    expect(failures).toEqual(["/pulls (503)"]);
  });
});
