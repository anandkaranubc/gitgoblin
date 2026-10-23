import { describe, expect, it } from "vitest";
import type { RepoFacts } from "@gitgoblin/core";
import { poolQueries, samplePool } from "../src/pool.ts";

function facts(owner: string, name: string): RepoFacts {
  return { host: "github.com", owner, name, url: "", topics: [], stars: 1, forks: 0, openIssues: 0, archived: false, fork: false };
}

describe("poolQueries", () => {
  it("uses star bands created before T and an open-ended push window implied by the 180-day rule", () => {
    const qs = poolQueries("rust", "2026-06-20T00:00:00Z");
    expect(qs.map((q) => q.label)).toEqual(["10-49 stars", "50-199 stars", "200-999 stars", "1000-4999 stars", "5000+ stars"]);
    expect(qs[0]!.q).toBe('stars:10..49 language:"rust" archived:false fork:false created:<2026-03-22 pushed:>2025-12-22');
    expect(qs[4]!.q).toContain("stars:>=5000");
    for (const q of qs) expect(q.q).not.toMatch(/pushed:\d{4}-\d{2}-\d{2}\.\./);
  });
});

describe("samplePool", () => {
  it("deduplicates across slices, keeps slice membership, and samples deterministically", () => {
    const found = [
      { facts: facts("a", "x"), slice: "starter issues" },
      { facts: facts("A", "X"), slice: "popular" },
      { facts: facts("b", "y"), slice: "popular" },
      { facts: facts("c", "z"), slice: "help wanted" },
    ];
    const all = samplePool(found, 10, 1);
    expect(all).toHaveLength(3);
    expect(all.find((m) => m.facts.owner === "a")?.slices).toEqual(["starter issues", "popular"]);
    const two = samplePool(found, 2, 1);
    expect(two).toHaveLength(2);
    expect(samplePool(found, 2, 1).map((m) => m.facts.name)).toEqual(two.map((m) => m.facts.name));
  });
});
