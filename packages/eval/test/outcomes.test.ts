import { describe, expect, it } from "vitest";
import { gradeOutcome, newcomerOutcomes, outsiderOutcomes, type PrRow, trackerStats, type IssueRow } from "../src/outcomes.ts";

const T = "2026-06-01T00:00:00Z";
const END = "2026-10-01T00:00:00Z";
const WINDOW = { start: T, end: END };

function pr(over: Partial<PrRow> & { number: number; createdAt: string }): PrRow {
  return {
    state: "MERGED",
    author: `u${over.number}`,
    authorIsBot: false,
    association: "NONE",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    linkedIssues: 0,
    labels: [],
    ...over,
  };
}

describe("newcomerOutcomes", () => {
  it("counts first-time outside authors in the window and their fate", () => {
    const prs = [
      pr({ number: 1, createdAt: "2026-01-10T00:00:00Z", author: "old", mergedAt: "2026-01-12T00:00:00Z" }), // before T: old is not a newcomer later
      pr({ number: 2, createdAt: "2026-06-10T00:00:00Z", author: "old", mergedAt: "2026-06-11T00:00:00Z" }),
      pr({ number: 3, createdAt: "2026-06-12T00:00:00Z", author: "alice", mergedAt: "2026-06-13T00:00:00Z", firstResponseAt: "2026-06-12T06:00:00Z" }),
      pr({ number: 4, createdAt: "2026-07-01T00:00:00Z", author: "bob", state: "CLOSED", closedAt: "2026-07-05T00:00:00Z", firstResponseAt: "2026-07-03T00:00:00Z" }),
      pr({ number: 5, createdAt: "2026-08-01T00:00:00Z", author: "carol", state: "OPEN" }),
      pr({ number: 6, createdAt: "2026-08-02T00:00:00Z", author: "dependabot[bot]", authorIsBot: true, mergedAt: "2026-08-03T00:00:00Z" }),
      pr({ number: 7, createdAt: "2026-08-03T00:00:00Z", author: "maint", association: "MEMBER", mergedAt: "2026-08-04T00:00:00Z" }),
      pr({ number: 8, createdAt: "2026-06-20T00:00:00Z", author: "alice", mergedAt: "2026-06-21T00:00:00Z" }), // alice's second PR still counts as hers
    ];
    const out = newcomerOutcomes(prs, WINDOW, "2025-06-01T00:00:00Z");
    expect(out.newcomers).toBe(3); // alice, bob, carol
    expect(out.pullRequests).toBe(4); // 3, 4, 5, 8
    expect(out.merged).toBe(2);
    expect(out.closedUnmerged).toBe(1);
    expect(out.open).toBe(1);
    expect(out.mergeRate).toBeCloseTo(2 / 3, 10);
    expect(out.medianResponseHours).toBe((6 + 48) / 2);
    expect(out.partialCoverage).toBe(false);
  });

  it("reports undefined rates when nothing was decided and flags short history", () => {
    const out = newcomerOutcomes([pr({ number: 1, createdAt: "2026-07-01T00:00:00Z", state: "OPEN" })], WINDOW, "2026-03-01T00:00:00Z");
    expect(out.mergeRate).toBeUndefined();
    expect(out.medianResponseHours).toBeUndefined();
    expect(out.partialCoverage).toBe(true);
  });

  it("ignores pull requests merged after the window end", () => {
    const prs = [pr({ number: 1, createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-10-15T00:00:00Z" })];
    const out = newcomerOutcomes(prs, WINDOW, "2025-01-01T00:00:00Z");
    expect(out.merged).toBe(0);
    expect(out.open).toBe(1);
  });
});

describe("gradeOutcome", () => {
  it("grades by merged count, rate and responsiveness", () => {
    expect(gradeOutcome({ merged: 0, mergeRate: undefined, medianResponseHours: undefined })).toBe(0);
    expect(gradeOutcome({ merged: 1, mergeRate: 1, medianResponseHours: 1 })).toBe(1);
    expect(gradeOutcome({ merged: 2, mergeRate: 0.4, medianResponseHours: 1 })).toBe(1);
    expect(gradeOutcome({ merged: 2, mergeRate: 0.5, medianResponseHours: 200 })).toBe(2);
    expect(gradeOutcome({ merged: 3, mergeRate: 0.75, medianResponseHours: 100 })).toBe(3);
  });
});

describe("trackerStats", () => {
  it("measures how much merged outside work referenced an issue and who closed completed issues", () => {
    const prs: PrRow[] = [
      pr({ number: 1, createdAt: "2026-02-01T00:00:00Z", mergedAt: "2026-02-02T00:00:00Z", linkedIssues: 1 }),
      pr({ number: 2, createdAt: "2026-02-03T00:00:00Z", mergedAt: "2026-02-04T00:00:00Z" }),
      pr({ number: 3, createdAt: "2026-02-05T00:00:00Z", mergedAt: "2026-02-06T00:00:00Z", association: "OWNER", linkedIssues: 1 }),
      pr({ number: 4, createdAt: "2026-02-07T00:00:00Z", state: "CLOSED", closedAt: "2026-02-08T00:00:00Z" }),
    ];
    const issues: IssueRow[] = [
      { number: 10, createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-02-02T00:00:00Z", stateReason: "COMPLETED", author: "x", authorIsBot: false, association: "NONE", labels: [], closedByPr: "outsider" },
      { number: 11, createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-02-02T00:00:00Z", stateReason: "COMPLETED", author: "x", authorIsBot: false, association: "NONE", labels: [], closedByPr: "maintainer" },
      { number: 12, createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-02-02T00:00:00Z", stateReason: "COMPLETED", author: "x", authorIsBot: false, association: "NONE", labels: [], closedByPr: "none" },
      { number: 13, createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-02-02T00:00:00Z", stateReason: "NOT_PLANNED", author: "x", authorIsBot: false, association: "NONE", labels: [], closedByPr: "none" },
    ];
    const stats = trackerStats(prs, issues, { start: "2026-01-15T00:00:00Z", end: "2026-03-01T00:00:00Z" });
    expect(stats.outsiderMerged).toBe(2);
    expect(stats.outsiderMergedWithIssue).toBe(1);
    expect(stats.completedIssues).toBe(3);
    expect(stats.completedByOutsiderPr).toBe(1);
    expect(stats.completedByAnyPr).toBe(2);
  });
});

describe("outsiderOutcomes", () => {
  it("counts every outside pull request in the window, first-timers or not", () => {
    const prs = [
      pr({ number: 1, createdAt: "2026-06-02T00:00:00Z", author: "old", mergedAt: "2026-06-03T00:00:00Z" }),
      pr({ number: 2, createdAt: "2026-06-04T00:00:00Z", author: "old", state: "CLOSED", closedAt: "2026-06-05T00:00:00Z" }),
      pr({ number: 3, createdAt: "2026-06-06T00:00:00Z", author: "new", state: "OPEN" }),
      pr({ number: 4, createdAt: "2026-06-07T00:00:00Z", author: "m", association: "OWNER", mergedAt: "2026-06-08T00:00:00Z" }),
      pr({ number: 5, createdAt: "2026-05-01T00:00:00Z", author: "early", mergedAt: "2026-05-02T00:00:00Z" }),
    ];
    expect(outsiderOutcomes(prs, WINDOW)).toEqual({ pullRequests: 3, merged: 1, closedUnmerged: 1, mergeRate: 0.5 });
  });
});
