import { describe, expect, it } from "vitest";
import { type Candidate, RANKINGS, rankCandidates } from "../src/baselines.ts";

function cand(id: string, over: Partial<Candidate> = {}): Candidate {
  return { id, language: "x", score: 0.5, stars: 10, starterIssuesAtT: 0, priorNewcomerMerged: 0, grade: 0, merged: 0, ...over };
}

describe("rankCandidates", () => {
  const pool = [
    cand("a", { score: 0.9, stars: 10, starterIssuesAtT: 0, daysSinceCommitAtT: 30, priorNewcomerMergeRate: 0.2, priorNewcomerMerged: 1 }),
    cand("b", { score: 0.2, stars: 5000, starterIssuesAtT: 3, daysSinceCommitAtT: 1 }),
    cand("c", { score: 0.5, stars: 200, starterIssuesAtT: 1, daysSinceCommitAtT: 10, priorNewcomerMergeRate: 0.9, priorNewcomerMerged: 4 }),
    cand("d", { score: 0.7, stars: 200, excluded: "archived" }),
  ];

  it("drops excluded candidates from every ranking and orders by the named key", () => {
    expect(rankCandidates(pool, "gitgoblin").map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(rankCandidates(pool, "stars").map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(rankCandidates(pool, "starterIssues").map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(rankCandidates(pool, "recency").map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(rankCandidates(pool, "priorNewcomers").map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("breaks ties by id so runs are reproducible, and puts unknowns last", () => {
    const tied = [cand("z", { stars: 1 }), cand("y", { stars: 1 }), cand("x", { stars: 1, daysSinceCommitAtT: 5 })];
    expect(rankCandidates(tied, "stars").map((c) => c.id)).toEqual(["x", "y", "z"]);
    expect(rankCandidates(tied, "recency").map((c) => c.id)).toEqual(["x", "y", "z"]);
  });

  it("shuffles deterministically for the random ranking", () => {
    const a = rankCandidates(pool, "random", 3).map((c) => c.id);
    const b = rankCandidates(pool, "random", 3).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(RANKINGS).toContain("random");
  });
});
