/**
 * Calibration harness against real repositories. Enable with GITGOBLIN_E2E=1.
 * Expectations are facts (nature, ecosystem, welcomeness band), not scores.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepository } from "../../src/index.ts";

interface Expectation {
  repo: string;
  nature?: string;
  ecosystem?: string;
  levels?: string[];
  opportunities?: number;
  excludeKinds?: string[];
  testCommand?: string;
}

const enabled = process.env.GITGOBLIN_E2E === "1";
const { repos } = JSON.parse(readFileSync(join(import.meta.dirname, "expectations.json"), "utf8")) as { repos: Expectation[] };

describe.skipIf(!enabled)("calibration expectations (live)", () => {
  for (const e of repos) {
    it(e.repo, async () => {
      const report = await analyzeRepository(e.repo, { checkLinks: false, dependencyChecks: false, maxOpportunities: 10 });
      const p = report.profile;
      if (e.nature) expect(p.nature).toBe(e.nature);
      if (e.ecosystem) expect(p.ecosystems.map((x) => x.name)).toContain(e.ecosystem);
      if (e.levels) expect(e.levels).toContain(p.welcomeness.level);
      if (e.opportunities !== undefined) expect(report.opportunities).toHaveLength(e.opportunities);
      if (e.excludeKinds) for (const o of report.opportunities) expect(e.excludeKinds).not.toContain(o.kind);
      if (e.testCommand) expect(p.ecosystems[0]?.commands.test).toMatch(new RegExp(e.testCommand));
      for (const o of report.opportunities) {
        expect(o.evidence.length).toBeGreaterThan(0);
        expect(o.factors).toHaveLength(5);
      }
    }, 240_000);
  }
});
