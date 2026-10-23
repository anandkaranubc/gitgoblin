import { describe, expect, it } from "vitest";
import type { GitHubApi } from "../src/github/client.ts";
import { fetchSamples, shrinking } from "../src/github/fetch.ts";

function fakeApi(handler: (query: string, vars: Record<string, unknown>) => unknown): GitHubApi & { calls: number[] } {
  const api = {
    calls: [] as number[],
    stats: { requests: 0 },
    async rest<T>(): Promise<T> { throw new Error("not used"); },
    async graphql<T>(query: string, vars: Record<string, unknown> = {}): Promise<T> {
      api.calls.push(vars.first as number);
      return handler(query, vars) as T;
    },
  };
  return api;
}

const issue = (n: number) => ({ number: n, title: `t${n}`, url: `https://github.com/o/r/issues/${n}`, body: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", closedAt: null, locked: false, author: { login: "a", __typename: "User" }, authorAssociation: "NONE", labels: { nodes: [{ name: "bug" }, null] }, assignees: { nodes: [] }, reactions: { totalCount: 1 }, comments: { totalCount: 0 }, firstComments: { nodes: [] }, lastComments: { nodes: [] }, timelineItems: { nodes: [null] } });
const pr = (n: number) => ({ number: n, title: `p${n}`, url: `https://github.com/o/r/pull/${n}`, state: "MERGED", isDraft: false, merged: true, mergedAt: "2026-01-03T00:00:00Z", closedAt: "2026-01-03T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", mergeable: "UNKNOWN", author: null, authorAssociation: "CONTRIBUTOR", additions: 1, deletions: 1, changedFiles: 1, headRefName: "x", labels: null, closingIssuesReferences: { nodes: [] }, firstComments: { nodes: [] }, reviews: { nodes: [null] } });

describe("shrinking", () => {
  it("keeps non-null nodes and halves the page while most nodes are null", async () => {
    const seen: number[] = [];
    const result = await shrinking(40, async (first: number) => {
      seen.push(first);
      // 40 -> all null, 20 -> half null, so 20 is accepted.
      return { nodes: Array.from({ length: first }, (_, i) => (first === 40 || i % 2 ? null : { i })) };
    }, (d: { nodes: ({ i: number } | null)[] }) => d.nodes);
    expect(seen).toEqual([40, 20]);
    expect(result.nodes).toHaveLength(10);
  });

  it("returns the best partial result when the smaller query fails", async () => {
    const result = await shrinking(20, async (first: number) => {
      if (first === 10) throw new Error("boom");
      return { nodes: [{ i: 1 }, null, null, null] };
    }, (d: { nodes: ({ i: number } | null)[] }) => d.nodes);
    expect(result.nodes).toEqual([{ i: 1 }]);
  });
});

describe("fetchSamples", () => {
  it("assembles four queries into one sample set, tolerating null holes", async () => {
    const api = fakeApi((query, vars) => {
      if (query.includes("query OpenIssues")) return { repository: { isMirror: false, labels: { nodes: [{ name: "help wanted" }, { name: "bug" }, null] }, pullRequests: { totalCount: 7 }, issues: { totalCount: 12, nodes: [issue(1), null, issue(3)] } } };
      if (query.includes("query ClosedIssues")) return { repository: { issues: { nodes: [{ number: 9, title: "c", url: "u", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", closedAt: "2026-01-02T00:00:00Z", locked: false, author: null, authorAssociation: "NONE", comments: { totalCount: 1 }, firstComments: { nodes: [] } }] } } };
      if (query.includes("query OpenPullRequests")) return { repository: { pullRequests: { nodes: [{ ...pr(5), state: "OPEN", merged: false, lastComments: { nodes: [] } }] } } };
      if (query.includes("query ClosedPullRequests")) return { repository: { pullRequests: { nodes: [pr(6), pr(7), null] } } };
      throw new Error(`unexpected query with first=${vars.first}`);
    });
    const samples = await fetchSamples(api, "o", "r");
    expect(samples.openIssueCount).toBe(12);
    expect(samples.openPrCount).toBe(7);
    expect(samples.labels).toEqual([{ name: "help wanted", openIssues: 0 }, { name: "bug", openIssues: 2 }]);
    expect(samples.openIssues.map((i) => i.number)).toEqual([1, 3]);
    expect(samples.openIssues[0]?.labels).toEqual(["bug"]);
    expect(samples.closedIssues).toHaveLength(1);
    expect(samples.closedIssues[0]?.labels).toEqual([]);
    expect(samples.openPrs[0]?.state).toBe("OPEN");
    expect(samples.closedPrs.map((p) => p.number)).toEqual([6, 7]);
    expect(samples.closedPrs[0]?.author).toBeUndefined();
    expect(api.calls).toEqual([80, 40, 40, 60]);
  });
});

describe("GitHub's secondary rate limit", () => {
  it("waits once and retries a query GitHub refused as a burst, and says which limit it was", async () => {
    const { RateLimitError } = await import("../src/github/client.ts");
    let refusals = 1;
    const api = fakeApi((query) => {
      if (query.includes("query OpenIssues") && refusals-- > 0) throw new RateLimitError("/graphql", 4000, { refused: true });
      if (query.includes("query OpenIssues")) return { repository: { isMirror: false, labels: { nodes: [] }, pullRequests: { totalCount: 0 }, issues: { totalCount: 1, nodes: [issue(1)] } } };
      return { repository: { issues: { nodes: [] }, pullRequests: { nodes: [] } } };
    });
    const samples = await fetchSamples(api, "o", "r", undefined, { burstRetryDelayMs: 1 });
    expect(samples.openIssues.map((i) => i.number)).toEqual([1]);
    const burst = new RateLimitError("/graphql", 3967, { refused: true });
    expect(burst.secondary).toBe(true);
    expect(burst.message).toBe("GitHub refused requests as rate limited (secondary limit; 3967 of the hourly quota left)");
    expect(new RateLimitError("/graphql", 0, { refused: true }).message).toMatch(/^GitHub rate limit reached \(0 left/);
  });
});
