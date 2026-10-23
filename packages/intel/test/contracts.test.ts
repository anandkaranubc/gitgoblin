import { describe, expect, it } from "vitest";
import { ContributionOpportunity, RepoRef } from "../src/contracts.ts";

describe("contracts", () => {
  it("defaults host to github", () => {
    expect(RepoRef.parse({ owner: "a", name: "b" }).host).toBe("github.com");
  });

  it("requires at least one piece of evidence per opportunity", () => {
    const result = ContributionOpportunity.safeParse({
      id: "x",
      repo: { owner: "a", name: "b" },
      kind: "issue",
      title: "t",
      summary: "s",
      evidence: [],
      factors: [],
      score: 0.5,
      effort: "small",
      skills: [],
      files: [],
      approach: [],
      acceptanceCriteria: [],
      etiquette: [],
      risks: [],
    });
    expect(result.success).toBe(false);
  });
});
