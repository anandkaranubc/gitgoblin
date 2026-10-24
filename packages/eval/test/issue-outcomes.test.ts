import { describe, expect, it } from "vitest";
import type { BacktestIssue } from "@gitgoblin/intel/backtest";
import { ageSplit, classify, type IssueRow, issueOutcome, strict, summarize } from "../src/issue-outcomes.ts";

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

describe("ageSplit", () => {
  it("compares recent and older accepted issues", () => {
    const row = (createdAt: string, outcome: IssueRow["outcome"], accepted = true): IssueRow => ({ repo: "o/n", number: 1, createdAt, selections: accepted ? ["all", "intelAccepted"] : ["all"], verdict: "issue", outcome });
    const split = ageSplit({ asOf: "2026-06-20T00:00:00.000Z", repos: [
      { repo: "a/b", openTruncated: false, issues: [row("2026-06-01T00:00:00Z", "outsider_pr"), row("2026-05-01T00:00:00Z", "open_or_later"), row("2025-01-01T00:00:00Z", "open_or_later"), row("2026-06-02T00:00:00Z", "outsider_pr", false)] },
      { repo: "c/d", openTruncated: false, issues: [row("2024-01-01T00:00:00Z", "outsider_pr"), row("2024-02-01T00:00:00Z", "open_or_later"), row("2024-03-01T00:00:00Z", "open_or_later")] },
    ] }, 90, { iterations: 50 });
    expect(split.recent).toEqual({ issues: 2, rate: 0.5 });
    expect(split.older).toEqual({ issues: 4, rate: 0.25 });
    expect(split.difference.estimate).toBeCloseTo(0.25, 10);
  });
});

describe("strict", () => {
  it("counts frequent closers as core and reporters' own fixes as not an outsider's", () => {
    const row = (n: number, fixer: string, reporter = "r"): IssueRow => ({ repo: "o/n", number: n, createdAt: "", selections: ["all"], verdict: "issue", outcome: "outsider_pr", fixer, reporter });
    const d = strict({ repos: [{ repo: "o/n", openTruncated: false, issues: [row(1, "busy"), row(2, "busy"), row(3, "busy"), row(4, "busy"), row(5, "once"), row(6, "self", "self")] }] });
    expect(d.repos[0]!.issues.map((i) => i.outcome)).toEqual(["maintainer_pr", "maintainer_pr", "maintainer_pr", "maintainer_pr", "outsider_pr", "self_fix"]);
  });
});
