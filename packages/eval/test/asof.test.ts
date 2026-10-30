import { describe, expect, it } from "vitest";
import { enrichedAsOf, type HistoryAsOf } from "../src/asof.ts";
import type { IssueRow, PrRow } from "../src/outcomes.ts";

const T = "2026-06-01T00:00:00Z";

function pr(number: number, createdAt: string, extra: Partial<PrRow> = {}): PrRow {
  return { number, createdAt, state: "MERGED", author: `a${number}`, authorIsBot: false, association: "NONE", additions: 1, deletions: 1, changedFiles: 1, linkedIssues: 0, labels: [], ...extra };
}
function issue(number: number, createdAt: string, extra: Partial<IssueRow> = {}): IssueRow {
  return { number, createdAt, author: `i${number}`, authorIsBot: false, association: "NONE", labels: [], closedByPr: "none", ...extra };
}

const history: HistoryAsOf = {
  prs: [
    pr(1, "2025-07-01T00:00:00Z", { mergedAt: "2025-07-11T00:00:00Z" }), // 10 days to merge, in the prior year
    pr(2, "2025-08-01T00:00:00Z", { state: "CLOSED", closedAt: "2025-08-21T00:00:00Z" }), // 20 days, closed unmerged
    pr(3, "2025-09-01T00:00:00Z", { state: "OPEN" }), // still open at T
    pr(4, "2025-03-01T00:00:00Z", { mergedAt: "2025-03-02T00:00:00Z" }), // older than a year before T
    pr(5, "2026-07-01T00:00:00Z", { mergedAt: "2026-07-02T00:00:00Z" }), // after T: must not leak
  ],
  issues: [
    issue(10, "2025-07-01T00:00:00Z", { closedAt: "2025-07-03T00:00:00Z", stateReason: "COMPLETED" }), // 2 days
    issue(11, "2025-10-01T00:00:00Z", { labels: ["good first issue"] }), // open at T, starter
    issue(12, "2025-10-02T00:00:00Z", { labels: ["help wanted"], closedAt: "2026-08-01T00:00:00Z" }), // closed after T: still open at T
    issue(13, "2025-10-03T00:00:00Z", { labels: ["good first issue"], closedAt: "2026-01-01T00:00:00Z" }), // closed before T
    issue(14, "2026-06-05T00:00:00Z", { labels: ["good first issue"] }), // created after T: must not leak
  ],
  commitsBefore: { count: 321, lastAt: "2026-05-20T00:00:00Z" },
  releasesBefore: { count: 4, latestAt: "2026-04-01T00:00:00Z" },
};

const current = {
  facts: { host: "github.com", owner: "o", name: "n", url: "https://github.com/o/n", topics: [], stars: 500, forks: 20, openIssues: 9, createdAt: "2020-01-01T00:00:00Z", pushedAt: "2026-09-30T00:00:00Z", archived: false, fork: false },
  details: {
    hasContributing: true, hasCodeOfConduct: false, issueTemplates: 1, hasIssuesEnabled: true, archived: false, license: "MIT",
    starterIssues: 7, starterIssueSamples: [], openIssues: 9, mergedPullRequests: 400, lastMergedAt: "2026-09-29T00:00:00Z", commitCount: 999, lastCommitAt: "2026-09-30T00:00:00Z", mentionableUsers: 40, releases: 9, latestReleaseAt: "2026-09-01T00:00:00Z",
  },
};

describe("enrichedAsOf", () => {
  it("rebuilds activity, releases and starter issues as of T and leaves current-only facts in place", () => {
    const repo = enrichedAsOf(current, history, T, ["good first issue", "help wanted"]);
    expect(repo.facts.pushedAt).toBe("2026-05-20T00:00:00Z");
    expect(repo.facts.stars).toBe(500);
    expect(repo.details?.commitCount).toBe(321);
    expect(repo.details?.lastCommitAt).toBe("2026-05-20T00:00:00Z");
    expect(repo.details?.releases).toBe(4);
    expect(repo.details?.latestReleaseAt).toBe("2026-04-01T00:00:00Z");
    expect(repo.details?.starterIssues).toBe(2); // 11 and 12
    expect(repo.details?.mergedPullRequests).toBe(2); // 1 and 4
    expect(repo.details?.lastMergedAt).toBe("2025-07-11T00:00:00Z");
    expect(repo.details?.hasContributing).toBe(true);
  });

  it("derives issue statistics for the year before T only", () => {
    const repo = enrichedAsOf(current, history, T, ["good first issue"]);
    const year = repo.issueStats?.pastYear;
    expect(year?.pullRequests).toBe(3); // 1, 2, 3
    expect(year?.mergedPullRequests).toBe(1);
    expect(year?.avgTimeToClosePrSec).toBe(((10 + 20) / 2) * 86_400);
    expect(year?.prAuthors).toBe(3);
    expect(year?.issues).toBe(4); // 10, 11, 12, 13
    expect(year?.avgTimeToCloseIssueSec).toBe(((2 + 90) / 2) * 86_400); // 10 closed in 2 days, 13 in 90 days
    expect(year?.issueAuthors).toBe(4);
    expect(repo.issueStats?.mergedPullRequests).toBe(1);
  });

  it("works without GraphQL details, leaving unknowns undefined", () => {
    const repo = enrichedAsOf({ facts: current.facts }, history, T, []);
    expect(repo.details).toBeUndefined();
    expect(repo.facts.pushedAt).toBe("2026-05-20T00:00:00Z");
  });
});
