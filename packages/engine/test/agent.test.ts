import { describe, expect, it } from "vitest";
import { SessionCostTracker } from "../src/agent.ts";

describe("SessionCostTracker", () => {
  it("reports only the increase for resumed sessions", () => {
    const costs = new SessionCostTracker();
    expect(costs.delta("s1", undefined, 1.0)).toBe(1.0);
    expect(costs.delta("s1", "s1", 1.5)).toBe(0.5);
    expect(costs.delta("s1", "s1", 3.5)).toBe(2.0);
    // A fresh session starts from zero.
    expect(costs.delta("s2", undefined, 0.6)).toBe(0.6);
    // A fork gets a new id but continues from the parent's total.
    expect(costs.delta("s3", "s1", 4.0)).toBe(0.5);
  });
  it("never reports a negative delta", () => {
    const costs = new SessionCostTracker();
    costs.delta("s1", undefined, 2);
    expect(costs.delta("s1", "s1", 1)).toBe(0);
  });
});
