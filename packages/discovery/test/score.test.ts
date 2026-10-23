import { describe, expect, it } from "vitest";
import { GOALS } from "@gitgoblin/core";
import { GOAL_PROFILES, scoreRepo } from "../src/index.ts";
import { abandonedLibrary, healthyLibrary, NOW, tinyNewProject } from "./fixtures.ts";

describe("scoreRepo", () => {
  it("ranks the healthy library first for contributing and excludes the abandoned one", () => {
    const healthy = scoreRepo(healthyLibrary(), "contribute", { now: NOW });
    const tiny = scoreRepo(tinyNewProject(), "contribute", { now: NOW });
    const abandoned = scoreRepo(abandonedLibrary(), "contribute", { now: NOW });

    expect(healthy.score).toBeGreaterThan(tiny.score);
    expect(abandoned.excluded).toBe("no pushes in the last 6 months");
    expect(abandoned.score).toBe(0);
    expect(healthy.reasons.some((r) => r.detail.includes("7 open starter issues"))).toBe(true);
    expect(healthy.reasons[0]?.weight).toBeGreaterThan(0);
  });

  it("flips the ordering for revive: the abandoned library wins and the active one is excluded", () => {
    const abandoned = scoreRepo(abandonedLibrary(), "revive", { now: NOW });
    const healthy = scoreRepo(healthyLibrary(), "revive", { now: NOW });

    expect(healthy.excluded).toBe("still active");
    expect(abandoned.excluded).toBeUndefined();
    expect(abandoned.score).toBeGreaterThan(0.6);
    expect(abandoned.reasons.some((r) => r.detail.includes("open issues show unmet demand"))).toBe(true);
    expect(abandoned.reasons.find((r) => r.signal === "activity")?.weight).toBeGreaterThan(0);
  });

  it("refuses unlicensed projects for adopt and revive", () => {
    expect(scoreRepo(tinyNewProject(), "adopt", { now: NOW }).excluded).toBe("no license");
    const tiny = tinyNewProject();
    tiny.facts.pushedAt = new Date(NOW - 400 * 86_400_000).toISOString();
    expect(scoreRepo(tiny, "revive", { now: NOW }).excluded).toMatch(/no license/);
  });

  it("prefers less-known projects for explore and applies a deterministic jitter", () => {
    const tiny = tinyNewProject();
    const a = scoreRepo(tiny, "explore", { now: NOW, jitter: 1 });
    const b = scoreRepo(tiny, "explore", { now: NOW, jitter: 1 });
    const c = scoreRepo(tiny, "explore", { now: NOW, jitter: -1 });
    expect(a.score).toBe(b.score);
    expect(a.score - c.score).toBeCloseTo(0.16, 3);
    expect(a.reasons.find((r) => r.signal === "jitter")?.weight).toBeCloseTo(0.08, 3);
    expect(a.reasons.find((r) => r.signal === "popularity")?.detail).toContain("less-known");
  });

  it("discounts scores when most signals are unknown", () => {
    const full = scoreRepo(healthyLibrary(), "adopt", { now: NOW });
    const sparse = scoreRepo({ facts: healthyLibrary().facts }, "adopt", { now: NOW });
    expect(sparse.score).toBeLessThan(full.score);
    const sparseSignals = sparse.reasons.map((r) => r.signal);
    expect(sparseSignals).not.toContain("busFactor");
    expect(sparseSignals).not.toContain("responsiveness");
    expect(full.reasons.map((r) => r.signal)).toContain("busFactor");
  });

  it("explains acceptance without weighing it in any goal yet", () => {
    for (const goal of GOALS) expect(GOAL_PROFILES[goal].weights.acceptance).toBeUndefined();
    const repo = healthyLibrary();
    repo.issueStats = { ...repo.issueStats!, pastYear: { ...repo.issueStats!.pastYear, mergedPullRequests: 6 } };
    const reason = scoreRepo(repo, "contribute", { now: NOW }).reasons.find((r) => r.signal === "acceptance");
    expect(reason).toMatchObject({ weight: 0, detail: "merged 10% of pull requests in the past year (6 of 60)" });
  });

  it("explains itself with human-readable evidence", () => {
    const { reasons } = scoreRepo(healthyLibrary(), "adopt", { now: NOW });
    const text = reasons.map((r) => r.detail).join(" | ");
    expect(text).toMatch(/used by 20k repositories via npm:good-lib/);
    expect(text).toMatch(/120 contributors, top committer wrote 40%/);
    expect(text).toMatch(/MIT \(permissive\)/);
    expect(text).toMatch(/issues close in ~3 days/);
    expect(text).toMatch(/README, description, homepage, changelog/);
    const sparse = scoreRepo({ facts: { ...healthyLibrary().facts, homepage: undefined } }, "learn", { now: NOW });
    expect(sparse.reasons.find((r) => r.signal === "docs")?.detail).toBe("description; no README, homepage, changelog");
    const shy = scoreRepo({ ...healthyLibrary(), details: { ...healthyLibrary().details!, hasContributing: false, issueTemplates: 0 } }, "contribute", { now: NOW });
    expect(shy.reasons.find((r) => r.signal === "newcomerFriendliness")?.detail).toBe("code of conduct; no CONTRIBUTING guide, issue templates");
    expect(reasons.length).toBe(11);
    expect(text).toMatch(/merged 83% of pull requests in the past year \(50 of 60\)/);
    expect(reasons.find((r) => r.signal === "newcomerFriendliness")?.weight).toBe(0);
  });

  it("has weights for every goal", () => {
    for (const profile of Object.values(GOAL_PROFILES)) {
      expect(Object.keys(profile.weights).length).toBeGreaterThanOrEqual(4);
    }
  });
});
