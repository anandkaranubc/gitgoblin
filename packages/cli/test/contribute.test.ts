import { describe, expect, it } from "vitest";
import { describeEnvironment, describeRun, engineWillRefuse, formatOpportunities, formatPlan, recommendedRank, selectOpportunity } from "../src/contribute.ts";
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

describe("describeRun", () => {
  const base = { runId: "20261023-044615-e4yw", runDir: "/w/runs/20261023-044615-e4yw", questions: [], workspace: undefined, branch: undefined, costUsd: 1.04, durationMs: 96_000 };

  it("keeps a short reason whole", () => {
    const lines = describeRun({ ...base, status: "stopped", reason: "plan rejected by the operator" });
    expect(lines[0]).toBe("Run stopped: plan rejected by the operator");
    expect(lines[1]).toBe("Cost: $1.04 in 96s");
    expect(lines[2]).toBe("Run directory: /w/runs/20261023-044615-e4yw");
  });

  it("cuts a long reason at its first sentence and points at the report, which carries the whole text", () => {
    const reason = "The behaviour reported in #511 was fixed by commit 70083b8 (#597) which removed the branch.; Regression coverage already exists and passes: tests/test_tenacity.py::test_get_fn_name.; Reproducing the issue at HEAD shows the expected log line; nothing left to change.; Recommended action: comment on #511.";
    const lines = describeRun({ ...base, status: "stopped", reason });
    expect(lines[0]).toBe("Run stopped: The behaviour reported in #511 was fixed by commit 70083b8 (#597) which removed the branch. (the report below has the rest)");
  });

  it("cuts a long sentence with no boundary at a word, and lists questions last", () => {
    const lines = describeRun({ ...base, status: "escalated", reason: "word ".repeat(60).trim(), questions: ["May the change edit .github/workflows/ci.yml?"] });
    expect(lines[0]!.length).toBeLessThanOrEqual("Run escalated: ".length + 200 + " (the report below has the rest)".length);
    expect(lines[0]).toMatch(/word… \(the report below has the rest\)$/);
    expect(lines.at(-1)).toBe("Question for you: May the change edit .github/workflows/ci.yml?");
  });
});

describe("text from issues and the model is shown without control characters", () => {
  const dirty = "Fix #42: \u001b[31mred\u001b[0m \u202etext";

  it("in the opportunity list", () => {
    const text = formatOpportunities(sampleReport([sampleOpportunity({ title: dirty, summary: "A\u0007 bell", evidence: [{ id: "e", kind: "issue", locator: "https://example.com/\u001b]8;;x\u0007", observedAt: "2026-10-22T00:00:00Z" }] })]), plain);
    expect(text).toContain("1. Fix #42: red text");
    expect(text).toContain("    A bell");
    expect(text).toContain("evidence: https://example.com/");
    // Newlines separate the list; nothing else below U+0020 may remain.
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202e]/);
  });

  it("in the status line and the plan", () => {
    const lines = describeRun({ runId: "r", runDir: "/w/runs/r", status: "escalated", reason: "needs\u001b[2K a human", questions: ["ok\u001b[31m?"], workspace: undefined, branch: undefined, costUsd: 0, durationMs: 0 });
    expect(lines[0]).toBe("Run escalated: needs a human");
    expect(lines.at(-1)).toBe("Question for you: ok?");
    const planText = formatPlan({ goal: "g\u001b[0m", steps: ["s\u0007"], filesToModify: ["a\u200b.ts"], filesToCreate: [], testsToAdd: [], outOfScope: [], risks: [], needsNewDependency: false });
    expect(planText).toContain("Plan: g\n  1. s\nFiles: a.ts");
  });
});

describe("describeEnvironment", () => {
  it("says nothing when the engine gave no context or everything passed at baseline", () => {
    expect(describeEnvironment(undefined)).toBeUndefined();
    expect(describeEnvironment({ baseline: [{ name: "test", status: "pass" }, { name: "lint", status: "pass" }] })).toBeUndefined();
    expect(describeEnvironment({ install: { exitCode: 0, logPath: "/r/install-output.txt" }, baseline: [] })).toBeUndefined();
  });

  it("warns that a change cannot be verified when the install failed and the checks are red", () => {
    const text = describeEnvironment({ install: { exitCode: 1, logPath: "/r/install-output.txt" }, baseline: [{ name: "typecheck", status: "fail" }, { name: "lint", status: "pass" }, { name: "test", status: "fail" }] });
    expect(text).toContain("the repository's install failed (exit 1); log: /r/install-output.txt");
    expect(text).toContain("Failing before any change: typecheck, test.");
    expect(text).toContain("cannot be verified");
  });

  it("says the install did not finish when the engine has no exit code for it", () => {
    const text = describeEnvironment({ install: { exitCode: null, logPath: "/r/install-output.txt" }, baseline: [{ name: "test", status: "timeout" }] });
    expect(text).toContain("the repository's install did not finish (killed or timed out); log: /r/install-output.txt");
    expect(text).toContain("cannot be verified");
  });

  it("warns about pre-existing failures when the install worked", () => {
    const text = describeEnvironment({ baseline: [{ name: "test", status: "fail" }, { name: "lint", status: "timeout" }] });
    expect(text).toContain("Failing before any change: test, lint.");
    expect(text).toContain("only catch new failures");
    expect(text).not.toContain("install failed");
  });
});

describe("when intel doubts a finding", () => {
  const doubtful = () =>
    sampleOpportunity({
      id: "opp-dddd4444",
      title: "Fix #511: Unreachable code in before_log reached",
      factors: [{ name: "confidence", score: 0.36, reason: "inferred from the issue text alone; code the issue quotes has changed since it was filed" }],
      risks: ["Code quoted in the issue was in tenacity/before.py when it was filed and is gone at HEAD; it may already be fixed.", "No maintainer has confirmed the issue."],
    });
  const confident = (id: string) => sampleOpportunity({ id, factors: [{ name: "confidence", score: 0.6, reason: "inferred from the issue text alone" }], risks: ["No maintainer has confirmed the issue; ask before investing heavily."] });

  it("shows its main risk in the list, and only for findings intel is unsure of", () => {
    const text = formatOpportunities(sampleReport([confident("opp-aaaa0001"), doubtful()]), plain);
    expect(text).toContain("    ? Code quoted in the issue was in tenacity/before.py when it was filed and is gone at HEAD; it may already be fixed.");
    expect(text).not.toContain("No maintainer has confirmed");
  });

  it("is not the default choice when a finding intel trusts is available", () => {
    expect(recommendedRank(sampleReport([doubtful(), confident("opp-aaaa0001")]))).toBe(2);
    expect(recommendedRank(sampleReport([doubtful()]))).toBe(1);
  });
});
