import { describe, expect, it } from "vitest";
import { assessLicense, computeSignals } from "../src/index.ts";
import { abandonedLibrary, facts, healthyLibrary, NOW, tinyNewProject } from "./fixtures.ts";

describe("computeSignals", () => {
  it("rates a healthy, welcoming library highly on every quality signal", () => {
    const { signals, evidence } = computeSignals(healthyLibrary(), NOW);
    expect(signals.activity).toBeGreaterThan(0.85);
    expect(signals.responsiveness).toBeGreaterThan(0.75);
    expect(signals.busFactor).toBeGreaterThan(0.6);
    expect(signals.newcomerFriendliness).toBeGreaterThan(0.85);
    expect(signals.docs).toBe(1);
    expect(signals.maturity).toBeGreaterThan(0.9);
    expect(signals.usage).toBeGreaterThan(0.6);
    expect(signals.license).toBe(1);
    expect(evidence).toMatchObject({ contributors: 120, goodFirstIssues: 7, hasContributing: true, dependentRepos: 20_000, hasReadme: true });
    expect(evidence.topContributorShare).toBeCloseTo(0.4, 5);
    expect(evidence.avgIssueCloseDays).toBeCloseTo(3, 5);
  });

  it("sees an abandoned library as inactive but heavily used", () => {
    const { signals, evidence } = computeSignals(abandonedLibrary(), NOW);
    expect(signals.activity).toBeLessThan(0.01);
    expect(signals.usage).toBeGreaterThan(0.7);
    expect(signals.busFactor).toBeLessThan(0.45);
    expect(evidence.daysSincePush).toBeCloseTo(3 * 365, 0);
    expect(evidence.packageNames?.[0]).toBe("npm:gone-lib");
    expect(evidence.dependentRepos).toBe(50_000);
    expect(signals.responsiveness).toBeLessThan(0.5);
  });

  it("marks a tiny new project as immature, unlicensed and single-handed", () => {
    const { signals } = computeSignals(tinyNewProject(), NOW);
    expect(signals.maturity).toBeLessThan(0.05);
    expect(signals.license).toBe(0);
    expect(signals.busFactor).toBeLessThan(0.1);
    expect(signals.activity).toBeGreaterThan(0.95);
    expect(signals.momentum).toBeGreaterThan(0.3);
    expect(signals.popularity).toBeLessThan(0.3);
    expect(signals.newcomerFriendliness).toBe(0);
  });

  it("leaves signals undefined instead of guessing when sources are missing", () => {
    const { signals, evidence } = computeSignals({ facts: facts({ owner: "a", name: "b", createdAt: undefined }) }, NOW);
    expect(signals.responsiveness).toBeUndefined();
    expect(signals.busFactor).toBeUndefined();
    expect(signals.newcomerFriendliness).toBeUndefined();
    expect(signals.maturity).toBeUndefined();
    expect(signals.momentum).toBeUndefined();
    expect(signals.activity).toBeGreaterThan(0.9);
    expect(signals.docs).toBeLessThanOrEqual(0.7);
    expect(evidence.hasReadme).toBeUndefined();
  });

  it("treats disabled issues as closed to newcomers", () => {
    const repo = healthyLibrary();
    repo.details = { ...repo.details!, hasIssuesEnabled: false };
    expect(computeSignals(repo, NOW).signals.newcomerFriendliness).toBe(0);
  });
});

describe("assessLicense", () => {
  it("classifies permissive, copyleft, custom and missing licenses", () => {
    expect(assessLicense("MIT").score).toBe(1);
    expect(assessLicense("unlicense").score).toBe(1);
    expect(assessLicense("GPL-3.0").score).toBe(0.75);
    expect(assessLicense("AGPL-3.0-only").score).toBe(0.75);
    expect(assessLicense("NOASSERTION")).toEqual({ score: 0.4, label: "custom license" });
    expect(assessLicense(undefined)).toEqual({ score: 0, label: "no license" });
  });
});
