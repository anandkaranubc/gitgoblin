/**
 * Live check of the language-model review. Needs GITGOBLIN_E2E=1 and Anthropic
 * credentials (ANTHROPIC_API_KEY or `ant auth login`); skipped otherwise.
 */
import { describe, expect, it } from "vitest";
import { analyzeRepository } from "../../src/index.ts";

const enabled = process.env.GITGOBLIN_E2E === "1" && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.GITGOBLIN_LLM_LIVE);

describe.skipIf(!enabled)("language-model issue review (live)", () => {
  it("adds grounded model evidence to issue opportunities and never fabricates issues", async () => {
    const report = await analyzeRepository("jd/tenacity", { llm: true, checkLinks: false, dependencyChecks: false, maxOpportunities: 10 });
    const issueOpps = report.opportunities.filter((o) => o.kind === "issue" || o.kind === "feature_request");
    expect(issueOpps.length).toBeGreaterThan(0);
    const reviewed = issueOpps.filter((o) => o.evidence.some((e) => e.locator.startsWith("llm:")));
    expect(reviewed.length).toBeGreaterThan(0);
    for (const o of reviewed) {
      const ev = o.evidence.find((e) => e.locator.startsWith("llm:"))!;
      expect(ev.excerpt && ev.excerpt.split(/\s+/).length <= 20).toBe(true); // short verbatim quote
      expect(o.issue?.number).toBeDefined();
    }
    expect(report.budget.notes.some((n) => n.startsWith("llm:"))).toBe(true);
    expect(report.budget.notes.some((n) => /language-model review (stopped|failed)/.test(n))).toBe(false);
  }, 300_000);
});
