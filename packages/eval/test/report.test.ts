import { describe, expect, it } from "vitest";
import type { IntelBacktestRow } from "../src/intel-backtest.ts";
import { renderIntel, renderKinds } from "../src/report.ts";

describe("renderIntel", () => {
  it("summarises acted-upon rates per kind, per rank, and the starter baseline", () => {
    const rows: IntelBacktestRow[] = [{
      id: "github.com/o/n", sha: "abcdef0123", committedDate: "2026-04-01T00:00:00Z", analyzedAt: "2026-10-23T00:00:00Z", issues: [], opportunities: 5, liveKindsDropped: 2, notes: [],
      findings: [
        { rank: 1, kind: "deprecation", title: "a", score: 0.7, effort: "small", path: "a.py", line: 1, excerpt: "x", status: "excerpt_gone", commit: { sha: "1", author: "A", date: "2026-05-01T00:00:00Z", daysAfter: 30, files: 2, prNumber: 9, by: "outsider" } },
        { rank: 3, kind: "deprecation", title: "d", score: 0.6, effort: "small", path: "d.py", line: 1, excerpt: "x", status: "excerpt_gone", commit: { sha: "2", author: "B", date: "2026-05-01T00:00:00Z", daysAfter: 30, files: 400, by: "maintainer" } },
        { rank: 2, kind: "deprecation", title: "b", score: 0.6, effort: "small", path: "b.py", line: 1, excerpt: "x", status: "unchanged" },
        { rank: 7, kind: "test_gap", title: "c", score: 0.5, effort: "medium", path: "c.py", line: undefined, excerpt: "x", status: "file_removed" },
      ],
      starter: { openAtT: 4, resolvedByOutsiderPr: 1, resolvedByMaintainerPr: 1, closedWithoutPr: 0, stillOpen: 2 },
    }];
    const md = renderIntel({ asOf: "2026-04-25T00:00:00Z", fetchedAt: "2026-10-23T00:00:00Z", rows });
    expect(md).toContain("| deprecation | 3 | 33% | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 33% | n/a |");
    expect(md).toContain("| test_gap | 1 | 0% | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0% | n/a |");
    expect(md).toContain("| top 5 | 3 | 33% | 33% | n/a |");
    expect(md).toContain("| 4 | 1 (25%) | 1 (25%) | 0 (0%) | 2 (50%) |");
  });
});

describe("renderKinds", () => {
  it("renders shares with and without an issue", () => {
    const empty = { withIssue: 0, withoutIssue: 0 };
    const md = renderKinds({ experiment: "tracker-kinds", asOf: "2026-06-20T00:00:00Z", fetchedAt: "2026-10-23T00:00:00Z", repositories: 2, sampledPullRequests: 10,
      byKind: { docs: { withIssue: 1, withoutIssue: 3 }, ci: empty, tests: empty, dependencies: { withIssue: 0, withoutIssue: 2 }, code: { withIssue: 3, withoutIssue: 1 }, mixed: empty },
      byLanguage: { python: { docs: { withIssue: 1, withoutIssue: 3 }, ci: empty, tests: empty, dependencies: { withIssue: 0, withoutIssue: 2 }, code: { withIssue: 3, withoutIssue: 1 }, mixed: empty } } });
    expect(md).toContain("| docs | 4 | 40% | 1 | 3 | 75% |");
    expect(md).toContain("| code | 4 | 40% | 3 | 1 | 25% |");
  });
});
