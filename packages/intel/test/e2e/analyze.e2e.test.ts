/**
 * Runs against GitHub. Enable with GITGOBLIN_E2E=1 (a token from `gh auth login`
 * or GITHUB_TOKEN gives issue analysis; without one the profile still builds).
 */
import { describe, expect, it } from "vitest";
import { analyzeRepository } from "../../src/index.ts";

const enabled = process.env.GITGOBLIN_E2E === "1";

describe.skipIf(!enabled)("analyzeRepository (live)", () => {
  it("profiles a Python library and finds grounded opportunities", async () => {
    const report = await analyzeRepository("jd/tenacity", { checkLinks: false, dependencyChecks: false, maxOpportunities: 10 });
    const p = report.profile;
    expect(p.nature).toBe("library");
    expect(p.ecosystems.map((e) => e.name)).toContain("python");
    expect(p.ecosystems[0]?.commands.test).toMatch(/pytest|tox/);
    expect(p.welcomeness.level).not.toBe("closed");
    for (const o of report.opportunities) {
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.score).toBeGreaterThan(0);
    }
  }, 180_000);

  it("closes a deprecated project and an archived one", async () => {
    const report = await analyzeRepository("request/request", { checkLinks: false, dependencyChecks: false });
    expect(report.profile.welcomeness.level).toBe("closed");
    expect(report.opportunities).toEqual([]);
    expect(report.skipped.length).toBeGreaterThan(0);
  }, 180_000);

  it("recognises an awesome list and skips code analyzers", async () => {
    const report = await analyzeRepository("sindresorhus/awesome", { checkLinks: false, dependencyChecks: false });
    expect(report.profile.nature).toBe("awesome_list");
    expect(report.opportunities.every((o) => !["test_gap", "deprecation", "tech_debt"].includes(o.kind))).toBe(true);
  }, 180_000);
});
