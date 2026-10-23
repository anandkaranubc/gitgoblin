import { describe, expect, it } from "vitest";
import { type Example, fitLogistic, leaveOneGroupOut, predict } from "../src/learn.ts";
import { seededRandom } from "../src/metrics.ts";

function synthetic(group: string, n: number, seed: number): Example[] {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => {
    const good = random();
    const noise = random();
    const label = good + 0.3 * (random() - 0.5) > 0.5;
    return { group, features: { good, noise, missing: random() > 0.5 ? undefined : random() }, label, baseline: 0.5 * good + 0.5 * noise };
  });
}

describe("fitLogistic", () => {
  it("learns that the informative feature matters and the noise does not", () => {
    const fit = fitLogistic(synthetic("a", 400, 1), ["good", "noise"]);
    expect(fit.weights[0]).toBeGreaterThan(1);
    expect(Math.abs(fit.weights[1]!)).toBeLessThan(0.5);
    expect(predict(fit, { good: 0.95, noise: 0.5 })).toBeGreaterThan(0.8);
    expect(predict(fit, { good: 0.05, noise: 0.5 })).toBeLessThan(0.2);
    expect(predict(fit, { good: undefined, noise: undefined })).toBeGreaterThan(0.2);
  });
});

describe("leaveOneGroupOut", () => {
  it("scores each group with a model trained on the others and beats a diluted baseline", () => {
    const examples = [...synthetic("a", 300, 2), ...synthetic("b", 300, 3), ...synthetic("c", 300, 4)];
    const results = leaveOneGroupOut(examples, ["good", "noise", "missing"]);
    expect(results.map((r) => r.group)).toEqual(["a", "b", "c"]);
    for (const r of results) {
      expect(r.n).toBe(300);
      expect(r.learned).toBeGreaterThan(0.85);
      expect(r.learned).toBeGreaterThan(r.baseline!);
      expect(r.single.good).toBeGreaterThan(0.85);
      expect(Math.abs(r.single.noise! - 0.5)).toBeLessThan(0.1);
    }
  });
});
