import { describe, expect, it } from "vitest";
import { workflowHealth } from "../src/analyzers/ci-health.ts";
import type { WorkflowRun } from "../src/github/types.ts";

const run = (n: number, conclusion: string, attempt = 1, workflowId = 1): WorkflowRun => ({
  id: n, name: "CI", path: ".github/workflows/ci.yml", workflowId, event: "push", conclusion, headSha: "abc", updatedAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`, attempt, url: `https://github.com/o/r/actions/runs/${n}`,
});

describe("workflowHealth", () => {
  it("counts the red streak from the newest run and re-runs that went green", () => {
    const runs = [run(1, "success"), run(2, "success", 2), run(3, "failure"), run(4, "failure"), run(5, "failure"), run(6, "success", 3, 2)];
    const health = workflowHealth(runs).sort((a, b) => a.runs[0]!.workflowId - b.runs[0]!.workflowId);
    expect(health[0]).toMatchObject({ redStreak: 3, rerunsToGreen: 1 });
    expect(health[0]?.runs[0]?.id).toBe(5);
    expect(health[1]).toMatchObject({ redStreak: 0, rerunsToGreen: 1 });
  });

  it("has no streak when the latest run passed", () => {
    expect(workflowHealth([run(1, "failure"), run(2, "success")])[0]?.redStreak).toBe(0);
  });
});
