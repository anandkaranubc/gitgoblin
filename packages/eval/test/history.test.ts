import { describe, expect, it } from "vitest";
import { GraphQLError, RateLimitError } from "@gitgoblin/sources";
import { isBot, rateLimitResetAt, toIssueRow, toPrRow } from "../src/github/history.ts";

describe("toPrRow", () => {
  it("takes the first response from someone other than the author and ignores bots", () => {
    const row = toPrRow({
      number: 1, createdAt: "2026-01-01T00:00:00Z", mergedAt: null, closedAt: null, state: "OPEN", additions: 1, deletions: 0, changedFiles: 1, authorAssociation: "NONE",
      author: { login: "alice", __typename: "User" },
      closingIssuesReferences: { totalCount: 2 },
      reviews: { nodes: [{ createdAt: "2026-01-03T00:00:00Z", author: { login: "maint", __typename: "User" } }] },
      comments: { nodes: [
        { createdAt: "2026-01-01T01:00:00Z", author: { login: "alice", __typename: "User" } },
        { createdAt: "2026-01-01T02:00:00Z", author: { login: "codecov", __typename: "Bot" } },
        { createdAt: "2026-01-02T00:00:00Z", author: { login: "maint", __typename: "User" } },
      ] },
    });
    expect(row.firstResponseAt).toBe("2026-01-02T00:00:00Z");
    expect(row.linkedIssues).toBe(2);
    expect(row.authorIsBot).toBe(false);
    expect(row.labels).toEqual([]);
  });

  it("flags bot authors by type, suffix and known logins", () => {
    expect(isBot({ login: "dependabot[bot]", __typename: "Bot" })).toBe(true);
    expect(isBot({ login: "pyup-bot", __typename: "User" })).toBe(true);
    expect(isBot({ login: "renovate", __typename: "User" })).toBe(true);
    expect(isBot({ login: "alice", __typename: "User" })).toBe(false);
    expect(isBot(null)).toBe(false);
  });
});

describe("toIssueRow", () => {
  const base = { number: 2, createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-02-01T00:00:00Z", stateReason: "COMPLETED" as const, authorAssociation: "NONE", author: { login: "bob", __typename: "User" }, labels: { nodes: [] } };

  it("attributes the closing merged pull request to an outsider or a maintainer", () => {
    expect(toIssueRow({ ...base, closedByPullRequestsReferences: { nodes: [{ merged: true, authorAssociation: "CONTRIBUTOR", author: { login: "x", __typename: "User" } }] } }).closedByPr).toBe("outsider");
    expect(toIssueRow({ ...base, closedByPullRequestsReferences: { nodes: [{ merged: true, authorAssociation: "MEMBER", author: { login: "m", __typename: "User" } }] } }).closedByPr).toBe("maintainer");
    expect(toIssueRow({ ...base, closedByPullRequestsReferences: { nodes: [{ merged: true, authorAssociation: "NONE", author: { login: "renovate[bot]", __typename: "Bot" } }] } }).closedByPr).toBe("maintainer");
    expect(toIssueRow({ ...base, closedByPullRequestsReferences: { nodes: [{ merged: false, authorAssociation: "NONE", author: { login: "x", __typename: "User" } }] } }).closedByPr).toBe("none");
  });
});

describe("rateLimitResetAt", () => {
  it("recognises both shapes of an exhausted budget and nothing else", () => {
    const reset = new Date("2026-10-23T05:15:35Z");
    expect(rateLimitResetAt(new RateLimitError("https://api.github.com/graphql", "", reset))).toEqual(reset);
    expect(rateLimitResetAt(new GraphQLError([{ type: "RATE_LIMIT", message: "exceeded" }]), reset)).toEqual(reset);
    expect(rateLimitResetAt(new GraphQLError([{ type: "RATE_LIMIT", message: "exceeded" }]))!.getTime()).toBeGreaterThan(Date.now());
    expect(rateLimitResetAt(new GraphQLError([{ type: "NOT_FOUND", message: "no" }]))).toBeUndefined();
    expect(rateLimitResetAt(new Error("boom"))).toBeUndefined();
  });
});

describe("withRateLimitRetry", () => {
  it("gives up after a few waits instead of spinning on an error that never clears", async () => {
    const { withRateLimitRetry } = await import("../src/github/history.ts");
    let calls = 0;
    const past = () => new Date(0);
    const fail = () => { calls++; return Promise.reject(new GraphQLError([{ type: "RATE_LIMIT" }])); };
    const origSetTimeout = globalThis.setTimeout;
    // Skip the real waits.
    globalThis.setTimeout = ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      await expect(withRateLimitRetry(fail, () => {}, past)).rejects.toBeInstanceOf(GraphQLError);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(calls).toBe(7);
  });
});
