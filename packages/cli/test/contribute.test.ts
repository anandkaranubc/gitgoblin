import { describe, expect, it } from "vitest";
import { engineWillRefuse, formatOpportunities, formatPlan, selectOpportunity } from "../src/contribute.ts";
import { sampleOpportunity, sampleReport } from "./fixtures.ts";

const plain = { color: false };

describe("formatOpportunities", () => {
  it("shows rank, title, kind, score, effort and the first piece of evidence for each opportunity", () => {
    const text = formatOpportunities(sampleReport(), plain);
    expect(text).toContain("1. Fix #42: --color flag is ignored on Windows");
    expect(text).toContain("issue · score 0.72 · small effort · id opp-aaaa1111");
    expect(text).toContain("https://github.com/acme/widget/issues/42");
    expect(text).toContain("2. Fix #57: panic on empty config");
    expect(text).toContain("3. Triage #61: unclear feature request");
  });

  it("warns about the opportunities the engine will refuse, in words a person can act on", () => {
    const text = formatOpportunities(sampleReport(), plain);
    expect(text).toContain("someone is already working on #57");
    expect(text).toContain("needs a reply on the issue, not a patch");
  });

  it("keeps each summary to one short line; the full text is in the report", () => {
    const long = "A".repeat(150) + "\n\n" + "B".repeat(150);
    const text = formatOpportunities(sampleReport([sampleOpportunity({ summary: long })]), plain);
    const summaryLine = text.split("\n").find((line) => line.includes("AAAA"))!;
    expect(summaryLine.length).toBeLessThanOrEqual(4 + 180);
    expect(summaryLine).toMatch(/…$/);
    expect(summaryLine).not.toContain("\n");
  });

  it("says when nothing was found", () => {
    expect(formatOpportunities(sampleReport([]), plain)).toMatch(/No contribution opportunities/);
  });
});

describe("engineWillRefuse", () => {
  it("names the reason for in-flight issues, triage and stale pull requests, and nothing otherwise", () => {
    expect(engineWillRefuse(sampleOpportunity())).toBeUndefined();
    expect(engineWillRefuse(sampleReport().opportunities[1]!)).toMatch(/already working on #57/);
    expect(engineWillRefuse(sampleReport().opportunities[2]!)).toMatch(/reply on the issue/);
    expect(engineWillRefuse(sampleOpportunity({ kind: "stale_pr", issue: undefined }))).toMatch(/original author/);
    expect(engineWillRefuse(sampleOpportunity({ kind: "hygiene", files: [] }))).toMatch(/names no files/);
  });
});

describe("selectOpportunity", () => {
  const report = sampleReport();

  it("finds an opportunity by id, by rank, or by issue number", () => {
    expect(selectOpportunity(report, { opportunity: "opp-bbbb2222" })?.id).toBe("opp-bbbb2222");
    expect(selectOpportunity(report, { opportunity: "3" })?.id).toBe("opp-cccc3333");
    expect(selectOpportunity(report, { issue: "42" })?.id).toBe("opp-aaaa1111");
    expect(selectOpportunity(report, { opportunity: "#61" })?.id).toBe("opp-cccc3333");
  });

  it("returns nothing when no choice was made, so the caller can ask", () => {
    expect(selectOpportunity(report, {})).toBeUndefined();
  });

  it("picks the only opportunity without being asked", () => {
    expect(selectOpportunity(sampleReport([sampleOpportunity()]), {})?.id).toBe("opp-aaaa1111");
  });

  it("explains what is available when the choice matches nothing", () => {
    expect(() => selectOpportunity(report, { opportunity: "opp-nope" })).toThrow(/No opportunity "opp-nope".*opp-aaaa1111/s);
    expect(() => selectOpportunity(report, { issue: "99" })).toThrow(/No opportunity for issue #99/);
    expect(() => selectOpportunity(report, { opportunity: "9" })).toThrow(/between 1 and 3/);
  });
});

describe("formatPlan", () => {
  it("renders the goal, steps, files, tests and risks of a change plan", () => {
    const text = formatPlan({
      goal: "Thread --color through to the renderer",
      steps: ["Pass the flag from main to render()", "Add a regression test"],
      filesToModify: ["src/main.rs", "src/render.rs"],
      filesToCreate: ["tests/color.rs"],
      testsToAdd: ["color flag disables escapes"],
      outOfScope: ["Windows terminal detection"],
      risks: ["render() is called from two places"],
      needsNewDependency: false,
    });
    expect(text).toContain("Plan: Thread --color through to the renderer");
    expect(text).toContain("  1. Pass the flag from main to render()");
    expect(text).toContain("Files: src/main.rs, src/render.rs; new: tests/color.rs");
    expect(text).toContain("Tests: color flag disables escapes");
    expect(text).toContain("Out of scope: Windows terminal detection");
    expect(text).toContain("Risks: render() is called from two places");
    expect(text).not.toContain("dependency");
  });

  it("calls out a new dependency, because that is a maintainer decision", () => {
    const text = formatPlan({ goal: "g", steps: ["s"], filesToModify: [], filesToCreate: [], testsToAdd: [], outOfScope: [], risks: [], needsNewDependency: true });
    expect(text).toContain("adds a new dependency");
  });
});
