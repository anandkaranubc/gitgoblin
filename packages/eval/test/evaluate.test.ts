import { describe, expect, it } from "vitest";
import { type BacktestRow, evaluate, toCandidate } from "../src/discovery-backtest.ts";
import { renderEvaluation, renderSlices, renderTracker } from "../src/report.ts";

function row(id: string, language: string, score: number, grade: number, merged: number, stars: number, excluded?: string): BacktestRow {
  const outcome = { newcomers: merged, pullRequests: merged, merged, closedUnmerged: 0, open: 0, mergeRate: merged ? 1 : undefined, medianResponseHours: 10, partialCoverage: false };
  return {
    id, language, slices: ["starter issues"], score, excluded, grade, starsNow: stars, starterIssuesAtT: 1, daysSinceCommitAtT: 3, reasons: [],
    enriched: { facts: { host: "github.com", owner: "o", name: id, url: "", topics: [], stars, forks: 0, openIssues: 0, archived: false, fork: false } },
    outcome, prior: { ...outcome, merged: 0, mergeRate: undefined },
    tracker: { outsiderMerged: 10, outsiderMergedWithIssue: 4, completedIssues: 20, completedByAnyPr: 10, completedByOutsiderPr: 3 },
    prsTruncated: false, issuesTruncated: false, prCount: 10, issueCount: 10,
  };
}

const rows: BacktestRow[] = [
  // gitgoblin orders ts well, stars orders it badly.
  row("a", "ts", 0.9, 3, 5, 10), row("b", "ts", 0.8, 2, 2, 20), row("c", "ts", 0.3, 0, 0, 9000), row("d", "ts", 0.2, 0, 0, 5000),
  row("e", "ts", 0.5, 1, 1, 50, "archived"),
  row("f", "py", 0.7, 0, 0, 100), row("g", "py", 0.6, 2, 3, 200), row("h", "py", 0.1, 3, 4, 300),
];

describe("evaluate", () => {
  it("scores every ranking per language and macro-averages", () => {
    const ev = evaluate({ rows, asOf: "2026-06-01T00:00:00Z" }, { k: 3, iterations: 50 });
    expect(ev.pools.map((p) => [p.language, p.candidates, p.eligible])).toEqual([["ts", 5, 4], ["py", 3, 3]]);
    expect(ev.perLanguage.ts!.gitgoblin.ndcg).toBeCloseTo(1, 10);
    expect(ev.perLanguage.ts!.stars.ndcg).toBeLessThan(0.6);
    expect(ev.perLanguage.py!.stars.ndcg).toBeCloseTo(1, 10);
    expect(ev.overall.gitgoblin.ndcg).toBeCloseTo((1 + ev.perLanguage.py!.gitgoblin.ndcg) / 2, 10);
    expect(ev.ndcgDelta.gitgoblin.estimate).toBe(0);
    expect(ev.ndcgDelta.stars.lower).toBeLessThanOrEqual(ev.ndcgDelta.stars.estimate);
    expect(ev.ndcgDelta.stars.upper).toBeGreaterThanOrEqual(ev.ndcgDelta.stars.estimate);
  });

  it("drops rows whose history does not reach back to T", () => {
    const late = { ...rows[0]!, id: "late", historyStart: "2026-07-01T00:00:00Z" };
    const ev = evaluate({ rows: [...rows, late], asOf: "2026-06-01T00:00:00Z" }, { k: 3, iterations: 10 });
    expect(ev.uncovered).toBe(1);
    expect(ev.pools.find((p) => p.language === "ts")?.candidates).toBe(5);
  });

  it("maps rows to candidates with the prior-year behavioural signal", () => {
    const c = toCandidate(rows[0]!);
    expect(c).toMatchObject({ id: "a", language: "ts", score: 0.9, stars: 10, grade: 3, merged: 5, priorNewcomerMerged: 0, priorNewcomerMergeRate: undefined });
  });

  it("renders markdown tables", () => {
    const ev = evaluate({ rows, asOf: "2026-06-01T00:00:00Z" }, { k: 3, iterations: 20 });
    const md = renderEvaluation({ asOf: "2026-06-01T00:00:00Z", windowDays: 120, fetchedAt: "2026-10-01T00:00:00Z", rows }, ev);
    expect(md).toContain("| ranking | nDCG@3 |");
    expect(md).toContain("most stars");
    const slices = renderSlices({ asOf: "2026-06-01T00:00:00Z", rows });
    expect(slices).toContain("| starter issues | 7 | 4 | 57% |");
    expect(slices).toContain("0 of 4 successes had no open starter-labelled issue at T");
    const tracker = renderTracker({ asOf: "2026-06-01T00:00:00Z", rows });
    expect(tracker).toContain("| all | 8 | 80 | 40% |");
  });
});

describe("examplesFrom", () => {
  it("recomputes discovery's signals from the stored input and adds the behavioural counts", async () => {
    const { examplesFrom, LEARN_FEATURES } = await import("../src/discovery-backtest.ts");
    const examples = examplesFrom({ rows, asOf: "2026-06-01T00:00:00Z" }, 2);
    expect(examples).toHaveLength(7); // the archived row is out
    const first = examples[0]!;
    expect(first.group).toBe("ts");
    expect(first.label).toBe(true);
    expect(first.baseline).toBe(0.9);
    expect(first.features.popularity).toBeGreaterThan(0);
    expect(first.features.priorOutsiderMerged).toBeCloseTo(Math.log1p(10), 10);
    expect(LEARN_FEATURES).toContain("priorNewcomerMergeRate");
  });
});
