import { describe, expect, it } from "vitest";
import { ciHealthAnalyzer, runsOnPullRequests, workflowHealth, workflowSecrets } from "../src/analyzers/ci-health.ts";
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

const SYNC = `name: Sync skills
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: npx clawhub sync
        env:
          CLAWHUB_TOKEN: \${{ secrets.CLAWHUB_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
const TESTS = `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

async function ciFindings(path: string, yaml: string, conclusions: string[], jobName: string) {
  const runs = conclusions.map((c, i) => ({ ...run(10 - i, c), name: path === ".github/workflows/ci.yml" ? "CI" : "Sync skills", path }));
  const ctx = {
    runs, github: undefined, samples: undefined, now: new Date("2026-10-24T00:00:00Z"), nowIso: "2026-10-24T00:00:00Z", ref: { host: "github.com", owner: "o", name: "r" },
    failedJobs: async () => [{ name: jobName, url: "https://github.com/o/r/actions/runs/10/job/1", failedSteps: ["Sync"] }],
    read: async (p: string) => (p === path ? yaml : undefined),
  } as never;
  return ciHealthAnalyzer.run(ctx, { defaultBranch: "main", languages: [] } as never);
}

describe("failing workflows a fork cannot run", () => {
  it("reads which secrets a workflow needs and whether pull requests trigger it", () => {
    expect(workflowSecrets(SYNC)).toEqual(["CLAWHUB_TOKEN"]);
    expect(workflowSecrets("jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n")).toEqual(["inherited"]);
    expect(workflowSecrets("# uses secrets.OLD_TOKEN no more\nname: x\n")).toEqual([]);
    expect(runsOnPullRequests(SYNC)).toBe(false);
    expect(runsOnPullRequests(TESTS)).toBe(true);
  });

  it("ranks a push-only job that needs secrets as one only maintainers can verify, and one failure as a single failure (heygen-com/hyperframes)", async () => {
    const [f] = await ciFindings(".github/workflows/sync.yml", SYNC, ["failure"], "Publish changed skills");
    expect(f?.title).toBe('Latest "Sync skills" run on main failed');
    expect(f?.signals.feasibility).toBe(0.3);
    expect(f?.signals.feasibilityReason).toMatch(/runs only after merge and needs repository secrets \(CLAWHUB_TOKEN\)/);
    expect(f?.risks?.[0]).toMatch(/^"Sync skills" runs only after merge and needs repository secrets/);
  });

  it("keeps an ordinary test workflow that forks can run as a fixable, repeated failure", async () => {
    const [f] = await ciFindings(".github/workflows/ci.yml", TESTS, ["failure", "failure"], "test");
    expect(f?.title).toMatch(/^CI workflow "CI" has been failing on main since/);
    expect(f?.signals.feasibility).toBe(0.65);
    expect(f?.risks?.[0]).toMatch(/^The failure may be an external service outage/);
  });
});
