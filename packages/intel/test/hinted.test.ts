import { describe, expect, it } from "vitest";
import type { GitHubApi } from "../src/github/client.ts";
import { fetchHintedIssues } from "../src/github/hinted.ts";

describe("fetchHintedIssues", () => {
  it("maps REST issues and comments, skipping closed issues and pull requests", async () => {
    const calls: string[] = [];
    const api: GitHubApi = {
      stats: { requests: 0 },
      async graphql<T>(): Promise<T> { throw new Error("unused"); },
      async rest<T>(path: string): Promise<T> {
        calls.push(path);
        if (path.endsWith("/issues/1")) return { number: 1, title: "Crash", html_url: "u1", body: "b", state: "open", locked: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", closed_at: null, user: { login: "u", type: "User" }, author_association: "NONE", labels: [{ name: "bug" }], assignees: [], comments: 1, reactions: { total_count: 3 } } as T;
        if (path.endsWith("/issues/1/comments")) return [{ created_at: "2026-01-02T00:00:00Z", body: "confirmed", user: { login: "m", type: "User" }, author_association: "MEMBER" }] as T;
        if (path.endsWith("/issues/2")) return { number: 2, title: "Closed", state: "closed", locked: false, html_url: "u2", body: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-03T00:00:00Z", user: null, author_association: "NONE", labels: [], assignees: [], comments: 0 } as T;
        if (path.endsWith("/issues/3")) return { number: 3, title: "A PR", state: "open", pull_request: {}, locked: false, html_url: "u3", body: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: null, user: null, author_association: "NONE", labels: [], assignees: [], comments: 0 } as T;
        throw new Error("404");
      },
    };
    const issues = await fetchHintedIssues(api, "o", "r", [1, 2, 3, 4]);
    expect(issues.map((i) => i.number)).toEqual([1]);
    expect(issues[0]).toMatchObject({ labels: ["bug"], reactions: 3, commentCount: 1 });
    expect(issues[0]?.lastComments[0]).toMatchObject({ association: "MEMBER", body: "confirmed" });
    expect(issues[0]?.firstComments[0]?.body).toBeUndefined();
    expect(calls).toHaveLength(5);
  });
});
