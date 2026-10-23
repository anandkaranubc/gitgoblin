import { describe, expect, it } from "vitest";
import { GOAL_DESCRIPTIONS, GOALS, isGoal, SIGNAL_DESCRIPTIONS, SIGNAL_NAMES } from "../src/index.ts";

describe("goals and signals", () => {
  it("recognizes every goal and nothing else", () => {
    for (const goal of GOALS) expect(isGoal(goal)).toBe(true);
    expect(isGoal("popular")).toBe(false);
  });

  it("documents every goal and signal", () => {
    for (const goal of GOALS) expect(GOAL_DESCRIPTIONS[goal]).toBeTruthy();
    for (const signal of SIGNAL_NAMES) expect(SIGNAL_DESCRIPTIONS[signal]).toBeTruthy();
  });
});
