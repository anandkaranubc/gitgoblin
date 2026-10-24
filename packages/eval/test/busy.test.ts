import { describe, expect, it } from "vitest";
import { outcomeFromWindow, searchRange, slices } from "../src/busy.ts";
import { newcomerOutcomes, type PrRow } from "../src/outcomes.ts";

const W = { start: "2026-06-01T00:00:00.000Z", end: "2026-09-29T00:00:00.000Z" };

function pr(n: number, author: string, createdAt: string, extra: Partial<PrRow> = {}): PrRow {
  return { number: n, createdAt, state: "MERGED", mergedAt: createdAt, author, authorIsBot: false, association: "NONE", additions: 1, deletions: 0, changedFiles: 1, linkedIssues: 0, labels: [], ...extra };
}

describe("slices and searchRange", () => {
  it("covers the window exactly with no overlap", () => {
    const s = slices(W, 30);
    expect(s).toHaveLength(4);
    expect(s[0]!.start).toBe(W.start);
    expect(s.at(-1)!.end).toBe(W.end);
    for (let i = 1; i < s.length; i++) expect(s[i]!.start).toBe(s[i - 1]!.end);
    expect(searchRange(s[0]!)).toBe("2026-06-01T00:00:00Z..2026-06-30T23:59:59Z");
  });
});

describe("outcomeFromWindow", () => {
  it("matches newcomerOutcomes on a full history when returning authors are known", () => {
    const history = [
      pr(1, "old", "2026-01-10T00:00:00Z"),
      pr(2, "old", "2026-06-10T00:00:00Z"),
      pr(3, "alice", "2026-06-12T00:00:00Z"),
      pr(4, "bob", "2026-07-01T00:00:00Z", { state: "CLOSED", mergedAt: undefined, closedAt: "2026-07-02T00:00:00Z" }),
      pr(5, "m", "2026-07-03T00:00:00Z", { association: "MEMBER" }),
    ];
    const full = newcomerOutcomes(history, W, "2025-06-01T00:00:00Z");
    const fromSearch = outcomeFromWindow(history.filter((p) => p.createdAt >= W.start), new Set(["old"]), W);
    expect(fromSearch).toEqual(full);
    expect(fromSearch.newcomers).toBe(2);
    expect(fromSearch.merged).toBe(1);
  });
});
