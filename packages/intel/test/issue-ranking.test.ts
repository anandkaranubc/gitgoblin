import { describe, expect, it } from "vitest";
import { assessIssue, issueSignals } from "../src/analyzers/issues.ts";
import type { CommentSample, IssueSample } from "../src/github/types.ts";

const now = new Date("2026-10-24T00:00:00Z");
const comment = (i: number): CommentSample => ({ createdAt: `2026-09-${String(10 + (i % 18)).padStart(2, "0")}T00:00:00Z`, author: { login: `u${i}`, isBot: false }, association: "NONE", body: `same here (${i})` });
function issue(over: Partial<IssueSample> = {}): IssueSample {
  return {
    number: 7, title: "Parser crashes on empty input", url: "https://github.com/o/r/issues/7",
    body: "Steps to reproduce:\n1. call parse('')\n\nIt raises IndexError instead of returning an empty list.",
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z", closedAt: undefined, locked: false, author: { login: "reporter", isBot: false }, association: "NONE",
    labels: ["bug"], assignees: [], reactions: 0, commentCount: 1, firstComments: [], lastComments: [comment(1)], linkedPrs: [], ...over,
  };
}
const signals = (i: IssueSample) => issueSignals(i, assessIssue(i, now, true, "https://github.com/o/r"), now).signals;

describe("issue ranking follows what outsiders fix", () => {
  it("does not reward long threads, and lowers feasibility for them", () => {
    const short = signals(issue());
    const long = signals(issue({ commentCount: 12, lastComments: Array.from({ length: 6 }, (_, i) => comment(i)) }));
    expect(long.value).toBe(short.value);
    expect(long.feasibility).toBeCloseTo(short.feasibility - 0.1);
    expect(long.feasibilityReason).toContain("12 comments: read the whole discussion first");
    expect(signals(issue({ commentCount: 6 })).feasibility).toBeCloseTo(short.feasibility - 0.05);
  });

  it("discounts issues open for over two years even when they saw recent activity", () => {
    const fresh = signals(issue());
    const old = signals(issue({ createdAt: "2023-06-01T00:00:00Z" }));
    expect(old.value).toBeCloseTo(fresh.value * 0.8);
    expect(old.valueReason).toContain("open for over two years");
  });

  it("gives documentation issues a feasibility boost", () => {
    const docs = issue({ title: "Docs: the README example for parse() is wrong", labels: ["documentation"], body: "The README example passes a list but parse() takes a string; the example raises TypeError." });
    const s = signals(docs);
    expect(assessIssue(docs, now, true, "https://github.com/o/r").isDocs).toBe(true);
    expect(s.feasibilityReason).toContain("documentation change");
  });
});
