import { describe, expect, it } from "vitest";
import { assessIssue, fetchIssueSamples, issueAsOf, issueScore } from "../src/backtest.ts";
import type { GitHubApi } from "../src/github/client.ts";

const node = (number: number, closer: unknown, stateReason = "COMPLETED") => ({
  number, title: "Crash on empty input", url: `https://github.com/o/r/issues/${number}`, body: "It crashes.\\n\\nTraceback (most recent call last):", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z",
  closedAt: "2026-03-01T00:00:00Z", locked: true, author: { login: "reporter", __typename: "User" }, authorAssociation: "NONE",
  labels: { nodes: [{ name: "bug" }] }, assignees: { nodes: [] }, reactions: { totalCount: 0 }, comments: { totalCount: 2 },
  firstComments: { nodes: [{ createdAt: "2026-01-02T00:00:00Z", authorAssociation: "MEMBER", author: { login: "maint", __typename: "User" } }] },
  lastComments: { nodes: [{ createdAt: "2026-01-02T00:00:00Z", authorAssociation: "MEMBER", author: { login: "maint", __typename: "User" }, body: "Confirmed, PR welcome." }, { createdAt: "2026-02-28T00:00:00Z", authorAssociation: "NONE", author: { login: "fixer", __typename: "User" }, body: "Fixed in #9." }] },
  timelineItems: { nodes: [{ source: { number: 9, url: "https://github.com/o/r/pull/9", state: "MERGED", isDraft: false, updatedAt: "2026-03-01T00:00:00Z" } }] },
  stateReason, closedBy: { nodes: [{ createdAt: "2026-03-01T00:00:00Z", closer }] },
});

describe("outcome backtest helpers", () => {
  it("returns issues with their close reason and the pull request that closed them, by whom", async () => {
    const api = { graphql: async () => ({ repository: { issues: { pageInfo: { endCursor: "c2", hasNextPage: true }, nodes: [
      node(1, { __typename: "PullRequest", number: 9, url: "https://github.com/o/r/pull/9", merged: true, mergedAt: "2026-03-01T00:00:00Z", authorAssociation: "CONTRIBUTOR", author: { login: "fixer", __typename: "User" } }),
      node(2, { __typename: "Commit" }, "NOT_PLANNED"),
      null,
    ] } } }) } as unknown as GitHubApi;
    const page = await fetchIssueSamples(api, "o", "r", { states: ["CLOSED"], first: 2 });
    expect(page).toMatchObject({ endCursor: "c2", hasNextPage: true });
    expect(page.issues.map((i) => [i.number, i.stateReason, i.closedBy?.authorAssociation, i.closedBy?.authorIsBot])).toEqual([[1, "COMPLETED", "CONTRIBUTOR", false], [2, "NOT_PLANNED", undefined, undefined]]);
  });

  it("reconstructs an issue as it looked before it was fixed, for the classifier", async () => {
    const api = { graphql: async () => ({ repository: { issues: { pageInfo: { endCursor: null, hasNextPage: false }, nodes: [node(1, null)] } } }) } as unknown as GitHubApi;
    const [issue] = (await fetchIssueSamples(api, "o", "r")).issues;
    const before = issueAsOf(issue!, new Date("2026-02-01T00:00:00Z"));
    expect(before).toMatchObject({ closedAt: undefined, locked: false, linkedPrs: [] });
    expect(before.lastComments.map((c) => c.body)).toEqual(["Confirmed, PR welcome."]);
    expect(assessIssue(before, new Date("2026-02-01T00:00:00Z"), true, "https://github.com/o/r").skipReason).toBeUndefined();
  });

  it("drops later activity from the comment count and the last update, so ranking inputs are as of then", async () => {
    const api = { graphql: async () => ({ repository: { issues: { pageInfo: { endCursor: null, hasNextPage: false }, nodes: [node(1, null)] } } }) } as unknown as GitHubApi;
    const [issue] = (await fetchIssueSamples(api, "o", "r")).issues;
    const before = issueAsOf(issue!, new Date("2026-02-01T00:00:00Z"));
    // Two comments today; the fix announcement came later. The maintainer's reply is the last thing seen before then.
    expect(before).toMatchObject({ commentCount: 1, updatedAt: "2026-01-02T00:00:00Z" });
    // Untouched since the cutoff: kept as is.
    expect(issueAsOf(issue!, new Date("2026-04-01T00:00:00Z"))).toMatchObject({ commentCount: 2, updatedAt: "2026-03-01T00:00:00Z" });
  });

  it("scores accepted issues the way a report ranks them: stale years-old issues fall below fresh ones", async () => {
    const api = { graphql: async () => ({ repository: { issues: { pageInfo: { endCursor: null, hasNextPage: false }, nodes: [node(1, null)] } } }) } as unknown as GitHubApi;
    const [issue] = (await fetchIssueSamples(api, "o", "r")).issues;
    const fresh = issueAsOf(issue!, new Date("2026-02-01T00:00:00Z"));
    const at = new Date("2026-02-01T00:00:00Z");
    const stale = { ...fresh, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2021-01-01T00:00:00Z" };
    const score = issueScore(fresh, assessIssue(fresh, at, true, "https://github.com/o/r"), at);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(issueScore(stale, assessIssue(stale, at, true, "https://github.com/o/r"), at)).toBeLessThan(score);
  });
});
