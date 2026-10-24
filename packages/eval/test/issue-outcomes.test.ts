import { describe, expect, it } from "vitest";
import type { BacktestIssue } from "@gitgoblin/intel/backtest";
import { classify, type IssueRow, issueOutcome, summarize } from "../src/issue-outcomes.ts";

const W = { start: "2026-06-20T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };

function issue(over: Partial<BacktestIssue> = {}): BacktestIssue {
  return {
    number: 1, title: "Crash when saving a file with a long name", url: "https://github.com/o/n/issues/1",
    body: "Steps to reproduce:\n1. run `x save`\n\nTraceback (most recent call last):\n  File \"x.py\", line 3\nValueError: too long",
    createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", closedAt: undefined, locked: false,
    author: { login: "reporter", isBot: false }, association: "NONE", labels: [], assignees: [], reactions: 0, commentCount: 0,
    firstComments: [], lastComments: [], linkedPrs: [], stateReason: undefined, closedBy: undefined,
    ...over,
  } as BacktestIssue;
}

describe("issueOutcome", () => {
  const pr = (authorAssociation: string, authorIsBot = false) => ({ number: 9, url: "", merged: true, mergedAt: "2026-07-01T00:00:00Z", authorLogin: "x", authorIsBot, authorAssociation }) as BacktestIssue["closedBy"];
  it("tells outsider fixes, maintainer fixes, other completions and refusals apart, inside the window only", () => {
    expect(issueOutcome(issue({ closedAt: "2026-07-02T00:00:00Z", stateReason: "COMPLETED", closedBy: pr("CONTRIBUTOR") }), W)).toBe("outsider_pr");
    expect(issueOutcome(issue({ closedAt: "2026-07-02T00:00:00Z", stateReason: "COMPLETED", closedBy: pr("MEMBER") }), W)).toBe("maintainer_pr");
    expect(issueOutcome(issue({ closedAt: "2026-07-02T00:00:00Z", stateReason: "COMPLETED", closedBy: pr("NONE", true) }), W)).toBe("maintainer_pr");
    expect(issueOutcome(issue({ closedAt: "2026-07-02T00:00:00Z", stateReason: "COMPLETED" }), W)).toBe("completed_other");
    expect(issueOutcome(issue({ closedAt: "2026-07-02T00:00:00Z", stateReason: "NOT_PLANNED" }), W)).toBe("not_planned");
    expect(issueOutcome(issue({ closedAt: "2026-11-01T00:00:00Z", stateReason: "COMPLETED", closedBy: pr("NONE") }), W)).toBe("open_or_later");
    expect(issueOutcome(issue(), W)).toBe("open_or_later");
  });
});

describe("classify", () => {
  it("puts an issue in every selection that applies", () => {
    const starter = new Set(["good first issue"]);
    const at = new Date(W.start);
    const labelled = classify(issue({ labels: ["good first issue", "bug"], createdAt: "2026-05-01T00:00:00Z" }), at, "https://github.com/o/n", starter);
    expect(labelled.selections).toEqual(expect.arrayContaining(["all", "starterLabel", "recent"]));
    const old = classify(issue({ createdAt: "2025-01-01T00:00:00Z" }), at, "https://github.com/o/n", starter);
    expect(old.selections).not.toContain("recent");
    expect(old.selections).not.toContain("starterLabel");
    expect(typeof old.verdict).toBe("string");
  });
});

describe("summarize", () => {
  it("measures each selection on the same issues", () => {
    const row = (selections: IssueRow["selections"], outcome: IssueRow["outcome"]): IssueRow => ({ repo: "o/n", number: 1, createdAt: "", selections, verdict: "issue", outcome });
    const s = summarize({ repos: [
      { repo: "a/b", openTruncated: false, issues: [row(["all", "intelAccepted"], "outsider_pr"), row(["all"], "open_or_later"), row(["all", "starterLabel"], "not_planned")] },
      { repo: "c/d", openTruncated: false, issues: [row(["all", "intelAccepted"], "open_or_later"), row(["all", "starterLabel"], "outsider_pr")] },
    ] }, { iterations: 50 });
    expect(s.all.issues).toBe(5);
    expect(s.all.outsiderPr.estimate).toBeCloseTo(2 / 5, 10);
    expect(s.intelAccepted.outsiderPr.estimate).toBeCloseTo(1 / 2, 10);
    expect(s.starterLabel.notPlanned).toBeCloseTo(1 / 2, 10);
    expect(s.intelTriage.issues).toBe(0);
  });
});
