import { describe, expect, it } from "vitest";
import { auc, bootstrap, ndcgAtK, precisionAtK, spearman } from "../src/metrics.ts";

describe("ndcgAtK", () => {
  it("is 1 for the ideal order and lower when a relevant item is pushed down", () => {
    expect(ndcgAtK([3, 2, 1, 0], 4)).toBeCloseTo(1, 10);
    expect(ndcgAtK([0, 1, 2, 3], 4)).toBeLessThan(0.7);
    expect(ndcgAtK([2, 3, 1, 0], 4)).toBeGreaterThan(ndcgAtK([0, 1, 2, 3], 4));
  });

  it("uses only the top k but the ideal from the whole pool", () => {
    // Top-2 of [0, 0, 3, 3] against the ideal [3, 3] is 0.
    expect(ndcgAtK([0, 0, 3, 3], 2)).toBe(0);
    expect(ndcgAtK([3, 0, 3, 0], 2)).toBeCloseTo((7 + 0) / (7 + 7 / Math.log2(3)), 10);
  });

  it("is 0 when nothing in the pool is relevant", () => {
    expect(ndcgAtK([0, 0, 0], 3)).toBe(0);
  });
});

describe("precisionAtK", () => {
  it("counts hits in the top k", () => {
    expect(precisionAtK([true, false, true, true], 2)).toBe(0.5);
    expect(precisionAtK([true, false, true, true], 4)).toBe(0.75);
    expect(precisionAtK([], 3)).toBe(0);
  });
});

describe("spearman", () => {
  it("is 1 for identical orderings and -1 for reversed ones", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it("handles ties with average ranks and refuses constant inputs", () => {
    expect(spearman([1, 1, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.9487, 3);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeUndefined();
    expect(spearman([1], [2])).toBeUndefined();
  });
});

describe("auc", () => {
  it("is the probability that a positive outscores a negative, ties counting half", () => {
    expect(auc([3, 4], [1, 2])).toBe(1);
    expect(auc([1, 2], [3, 4])).toBe(0);
    expect(auc([2, 2], [2, 1])).toBe(0.75);
    expect(auc([], [1])).toBeUndefined();
  });
});

describe("bootstrap", () => {
  it("brackets the statistic and is reproducible for a seed", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const mean = (idx: number[]) => idx.reduce((s, i) => s + values[i]!, 0) / idx.length;
    const a = bootstrap(values.length, mean, { iterations: 500, seed: 7 });
    const b = bootstrap(values.length, mean, { iterations: 500, seed: 7 });
    expect(a).toEqual(b);
    expect(a.estimate).toBeCloseTo(5.5, 10);
    expect(a.lower).toBeLessThan(5.5);
    expect(a.upper).toBeGreaterThan(5.5);
    expect(a.lower).toBeGreaterThan(2);
    expect(a.upper).toBeLessThan(9);
  });
});
