import { describe, expect, it } from "vitest";
import type { Finding } from "../src/analyzers/types.ts";
import type { RepositoryProfile } from "../src/contracts.ts";
import { aggregate, cluster, evaluate, rejectionReason, scoreFactors } from "../src/evaluate/index.ts";

export function profileWith(over: Partial<RepositoryProfile> = {}): RepositoryProfile {
  return {
    repo: { host: "github.com", owner: "o", name: "r" }, analyzedAt: "2026-10-22T00:00:00Z", headSha: "abc", defaultBranch: "main",
    topics: [], stars: 100, forks: 10, archived: false, isFork: false, nature: "library", natureReason: "test", languages: [], ecosystems: [],
    ci: { provider: "none", workflows: [] }, structure: { fileCount: 1, analyzedFileCount: 1, sourceDirs: [], testDirs: [], docsDirs: [], entryPoints: [] },
    activity: { commits90d: 1, commits365d: 1, authors90d: 1, authors365d: 1, busFactor: 1, openIssues: 0, openPullRequests: 0, sampleSizes: { issues: 0, pullRequests: 0, externalPullRequests: 0 } },
    welcomeness: { score: 0.6, level: "open", signals: [], rules: { requiresIssueFirst: false, cla: false, dco: false, issueTemplates: false, pullRequestTemplate: false, helpLabels: [], rejectedChanges: [], dependencyBot: false, requiresTests: false, requiresChangelog: false } },
    conventions: { commitStyle: "unknown", recentCommitSubjects: [] }, hotFiles: [], instructionFiles: [], notes: [], ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    kind: "ci_rot", clusterKey: "k", title: "t", summary: "s", files: ["a.yml"], effort: "trivial", skills: [], approach: [], acceptanceCriteria: [],
    evidence: [{ id: `ev-${Math.random()}`, kind: "file", locator: "a.yml:1", observedAt: "2026-10-22T00:00:00Z" }],
    signals: { value: 0.8, valueReason: "v", feasibility: 0.9, feasibilityReason: "f", confidence: 0.9, confidenceReason: "c" },
    ...over,
  };
}

describe("evaluate", () => {
  it("sinks the score when any factor is near zero", () => {
    const good = aggregate(scoreFactors(finding(), profileWith()));
    const inFlight = aggregate(scoreFactors(finding({ signals: { ...finding().signals, novelty: 0.1 } }), profileWith()));
    const unwelcome = aggregate(scoreFactors(finding(), profileWith({ welcomeness: { ...profileWith().welcomeness, score: 0.05, level: "dormant" } })));
    expect(good).toBeGreaterThan(0.7);
    expect(inFlight).toBeLessThan(good * 0.85);
    expect(unwelcome).toBeLessThan(good * 0.6);
  });

  it("rejects findings for archived or closed repositories and in-flight work", () => {
    expect(rejectionReason(finding(), profileWith({ archived: true }))).toMatch(/archived/);
    expect(rejectionReason(finding(), profileWith({ welcomeness: { ...profileWith().welcomeness, score: 0, level: "closed" } }))).toMatch(/closed/);
    expect(rejectionReason(finding({ signals: { ...finding().signals, novelty: 0.05, noveltyReason: "linked PR #4 is open" } }), profileWith())).toBe("linked PR #4 is open");
    expect(rejectionReason(finding({ kind: "test_gap" }), profileWith({ nature: "awesome_list" }))).toMatch(/does not apply/);
    expect(rejectionReason(finding(), profileWith())).toBeUndefined();
  });

  it("clusters by key, merges evidence and bumps value slightly", () => {
    const merged = cluster([finding(), finding(), finding({ clusterKey: "other" })]);
    expect(merged).toHaveLength(2);
    const big = merged.find((m) => m.clusterKey === "k")!;
    expect(big.evidence).toHaveLength(2);
    expect(big.signals.value).toBeCloseTo(0.824, 2);
  });

  it("ranks, truncates and explains what was skipped", () => {
    const result = evaluate([
      finding({ clusterKey: "a", signals: { ...finding().signals, value: 0.9 } }),
      finding({ clusterKey: "b", signals: { ...finding().signals, value: 0.3 } }),
      finding({ clusterKey: "c", signals: { ...finding().signals, novelty: 0.05 } }),
    ], profileWith(), 1);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.id).toMatch(/^opp-/);
    expect(result.opportunities[0]?.factors.map((f) => f.name)).toEqual(["value", "feasibility", "welcomeness", "confidence", "novelty"]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "someone is already working on it",
      expect.stringMatching(/ranked below the top 1/),
    ]);
  });
});
