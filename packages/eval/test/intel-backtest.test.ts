import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContributionOpportunity } from "@gitgoblin/intel";
import { acceptedIssues, controlLine, gradeFinding, gradeIssue, isLiveFinding, starterBaseline, subkind } from "../src/intel-backtest.ts";

function sh(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z", GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "a@x" } });
}

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-grade-"));
  sh(["init", "-q", "-b", "main"], dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.py"), "import imp\nprint('hello there world')\n");
  writeFileSync(join(dir, "src/b.py"), "# TODO remove after 3.8\nx = 1\n");
  writeFileSync(join(dir, "src/c.py"), "unchanged = True\n");
  writeFileSync(join(dir, "src/d.py"), "# FIXME: moved later on\n");
  sh(["add", "."], dir);
  sh(["commit", "-q", "-m", "base"], dir);
  sh(["mv", "src/d.py", "src/e.py"], dir);
  sh(["commit", "-q", "-m", "rename d"], dir);
  writeFileSync(join(dir, "src/a.py"), "import importlib\nprint('hello there world')\n");
  sh(["commit", "-q", "-am", "drop imp"], dir);
  sh(["rm", "-q", "src/b.py"], dir);
  sh(["commit", "-q", "-m", "remove b"], dir);
  return dir;
}

function opp(kind: string, locator: string, excerpt: string): ContributionOpportunity {
  return {
    id: "x", repo: { host: "github.com", owner: "o", name: "n" }, kind: kind as ContributionOpportunity["kind"], title: kind, summary: "", score: 0.5, effort: "small", skills: [], files: [], approach: [], acceptanceCriteria: [], etiquette: [], risks: [],
    factors: [],
    evidence: [{ id: "e", kind: "file", locator, excerpt, observedAt: "2026-06-01T00:00:00Z" }],
  };
}

describe("gradeFinding", () => {
  it("tells unchanged, removed and gone excerpts apart and attributes the removing commit", async () => {
    const dir = fixtureRepo();
    const lookup = async () => ({ prNumber: 7, by: "outsider" as const });
    const gone = await gradeFinding(opp("deprecation", "src/a.py:1", "import imp"), 1, dir, "HEAD", "2026-06-01T00:00:00Z", lookup);
    expect(gone?.status).toBe("excerpt_gone");
    expect(gone?.commit?.by).toBe("outsider");
    expect(gone?.commit?.prNumber).toBe(7);
    expect(gone?.commit?.author).toBe("Ann");
    expect(gone?.commit?.daysAfter).toBe(61);
    expect(gone?.commit?.files).toBe(1);
    const moved = await gradeFinding(opp("tech_debt", "src/d.py:1", "# FIXME: moved later on"), 4, dir, "HEAD", "2026-06-01T00:00:00Z", lookup);
    expect(moved?.status).toBe("moved");
    const removed = await gradeFinding(opp("tech_debt", "src/b.py:1", "# TODO remove after 3.8"), 2, dir, "HEAD", "2026-06-01T00:00:00Z", lookup);
    expect(removed?.status).toBe("file_removed");
    const same = await gradeFinding(opp("test_gap", "src/c.py", "unchanged = True"), 3, dir, "HEAD", "2026-06-01T00:00:00Z", lookup);
    expect(same?.status).toBe("unchanged");
    expect(same?.line).toBeUndefined();
  });

  it("skips opportunities without file evidence", async () => {
    const o = opp("issue", "https://github.com/o/n/issues/1", "text");
    o.evidence[0]!.kind = "issue";
    expect(await gradeFinding(o, 1, "/nonexistent", "HEAD", "2026-06-01T00:00:00Z", async () => ({ by: "unknown" as const }))).toBeUndefined();
  });
});

describe("controlLine", () => {
  it("picks a stable random line that is not the finding", () => {
    const content = "short\nimport imp\nthis is a long enough line\nanother long enough line here\n";
    const a = controlLine(content, "import imp", 3);
    expect(a).toBeDefined();
    expect(a).not.toBe("import imp");
    expect(controlLine(content, "import imp", 3)).toBe(a);
    expect(controlLine("x\n", "import imp", 1)).toBeUndefined();
  });

  it("grades the control line of the file at T", async () => {
    const dir = fixtureRepo();
    const base = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const graded = await gradeFinding(opp("deprecation", "src/a.py:1", "import imp"), 1, dir, "HEAD", "2026-06-01T00:00:00Z", async () => ({ by: "unknown" as const }), base);
    expect(graded?.status).toBe("excerpt_gone");
    expect(graded?.control).toBe("unchanged"); // print('hi') survived
    const fake = await gradeFinding(opp("hygiene", "src/a.py", "never, in, this, file"), 2, dir, "HEAD", "2026-06-01T00:00:00Z", async () => ({ by: "unknown" as const }), base);
    expect(fake?.status).toBe("unverifiable");
  });
});

describe("subkind", () => {
  it("maps titles onto the analyzers' clusters", () => {
    expect(subkind("test_gap", "Investigate and re-enable skipped or expected-failure tests")).toBe("skipped-tests");
    expect(subkind("test_gap", "Add tests for src/hot.py")).toBe("untested");
    expect(subkind("broken_link", "Fix links to files that no longer exist in the repository")).toBe("relative");
    expect(subkind("tech_debt", "Resolve a 5.7-year-old XXX in scripts/x.js")).toBe("old");
    expect(subkind("deprecation", "anything")).toBe("deprecation");
  });
});

describe("starterBaseline", () => {
  it("counts starter issues open at T by what happened to them", () => {
    const T = "2026-06-01T00:00:00Z";
    const b = starterBaseline([
      { createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-07-01T00:00:00Z", closedByPr: "outsider" },
      { createdAt: "2026-01-02T00:00:00Z", closedAt: "2026-07-01T00:00:00Z", closedByPr: "maintainer" },
      { createdAt: "2026-01-03T00:00:00Z", closedAt: "2026-07-01T00:00:00Z", closedByPr: "none" },
      { createdAt: "2026-01-04T00:00:00Z", closedByPr: "none" },
      { createdAt: "2026-01-05T00:00:00Z", closedAt: "2026-02-01T00:00:00Z", closedByPr: "outsider" }, // closed before T
      { createdAt: "2026-06-05T00:00:00Z", closedAt: "2026-07-01T00:00:00Z", closedByPr: "outsider" }, // created after T
    ], T);
    expect(b).toEqual({ openAtT: 4, resolvedByOutsiderPr: 1, resolvedByMaintainerPr: 1, closedWithoutPr: 1, stillOpen: 1 });
  });
});

describe("containsExcerpt", () => {
  it("matches whole tokens after whitespace normalization", async () => {
    const { containsExcerpt } = await import("../src/intel-backtest.ts");
    expect(containsExcerpt("import importlib\n", "import imp")).toBe(false);
    expect(containsExcerpt("x = 1\nimport imp\n", "import imp")).toBe(true);
    expect(containsExcerpt("foo(  alpha,\n   beta )", "foo( alpha, beta )")).toBe(true);
    expect(containsExcerpt("uses-node12: true", "uses-node12")).toBe(true);
    expect(containsExcerpt("uses-node12: true", "uses-node1")).toBe(false);
    expect(containsExcerpt("short", "short")).toBe(true);
    expect(containsExcerpt("    #[ignore]\n    fn slow() {}", "#[ignore]")).toBe(true);
    expect(containsExcerpt("    fn slow() {}", "#[ignore]")).toBe(false);
  });
});

describe("acceptedIssues and gradeIssue", () => {
  it("keeps issue-backed opportunities and notices intel's own already-fixed warning", () => {
    const o = opp("issue", "https://github.com/o/n/issues/7", "text");
    o.issue = { number: 7, url: "", title: "t", labels: [], assignees: [], inFlight: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    o.factors = [{ name: "confidence", score: 0.6, reason: "" }];
    o.risks = ["The quoted code is gone from HEAD, so this may already be fixed."];
    const plain = opp("deprecation", "a.py:1", "x");
    const accepted = acceptedIssues([plain, o]);
    expect(accepted).toEqual([{ number: 7, kind: "issue", rank: 2, score: 0.5, confidence: 0.6, flaggedAlreadyFixed: true }]);
  });

  it("grades fate, who fixed it, and whether the fix predates the run", () => {
    const issue = { number: 1, kind: "issue", rank: 1, score: 0.5, confidence: 0.5, flaggedAlreadyFixed: false };
    const run = "2026-05-01T00:00:00Z";
    expect(gradeIssue(issue, run, undefined).fate).toBe("open");
    expect(gradeIssue(issue, run, { state: "OPEN", stateReason: null, closedAt: null, closingPrs: [] }).fate).toBe("open");
    expect(gradeIssue(issue, run, { state: "OPEN", stateReason: null, closedAt: null, closingPrs: [{ mergedAt: "2026-04-01T00:00:00Z", authorAssociation: "NONE", authorIsBot: false }] })).toMatchObject({ fate: "open_with_merged_pr", fixedBeforeRun: true });
    const early = gradeIssue(issue, run, { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-06-01T00:00:00Z", closingPrs: [{ mergedAt: "2026-04-01T00:00:00Z", authorAssociation: "NONE", authorIsBot: false }] });
    expect(early).toMatchObject({ fate: "completed_by_pr", fixedBeforeRun: true, fixedBy: "outsider", fixedAt: "2026-04-01T00:00:00Z" });
    const late = gradeIssue(issue, run, { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-06-01T00:00:00Z", closingPrs: [{ mergedAt: "2026-05-20T00:00:00Z", authorAssociation: "MEMBER", authorIsBot: false }] });
    expect(late).toMatchObject({ fate: "completed_by_pr", fixedBeforeRun: false, fixedBy: "maintainer" });
    expect(gradeIssue(issue, run, { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-06-01T00:00:00Z", closingPrs: [] }).fate).toBe("completed_without_pr");
    expect(gradeIssue(issue, run, { state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: "2026-06-01T00:00:00Z", closingPrs: [] }).fate).toBe("not_planned");
  });
});

describe("containsExcerpt on reconstructed excerpts", () => {
  it("matches across comment markers, punctuation and line breaks but still whole tokens", async () => {
    const { containsExcerpt, anchorPhrase } = await import("../src/intel-backtest.ts");
    const file = "    // TODO: .\n    // We should be able to replace this entire function body\n    fn x() {}\n";
    expect(containsExcerpt(file, "TODO: . We should be able to replace this entire function body")).toBe(true);
    expect(containsExcerpt("import importlib\n", "import imp")).toBe(false);
    expect(containsExcerpt("foo_bar = 1\n", "foo bar")).toBe(false);
    expect(containsExcerpt("# FIXME remove after 3.8\n", "FIXME remove after 3.8")).toBe(true);
    expect(anchorPhrase("TODO: . We should be able to replace this entire function body")).toBe("We should be able to replace this entire function body");
    expect(anchorPhrase("[Docker](./x.md)")).toBeUndefined();
    expect(anchorPhrase("[Gemini Multimodal Agent](starter_ai_agents/gemini_multimodal_agent_demo/)")).toBe("starter_ai_agents/gemini_multimodal_agent_demo/");
    expect(anchorPhrase("@pytest.mark.xfail(not (sys.version_info >= (3, 13)), reason=\"failing test\")")).toBeUndefined();
    expect(containsExcerpt("// TODO: handle methods, for now return early in a class body. For example, an additional\n", "TODO: handle methods, for now return early in a class body. For exampl…")).toBe(true);
    expect(containsExcerpt("// TODO: handle methods\n", "TODO: handle methods, for now…")).toBe(false);
  });
});

describe("isLiveFinding", () => {
  it("keeps rule-table CI findings and drops run-based ones", () => {
    const file = { id: "e", kind: "file" as const, locator: ".github/workflows/ci.yml:3", excerpt: "runs-on: ubuntu-20.04", observedAt: "" };
    const run = { id: "r", kind: "workflow_run" as const, locator: "https://github.com/o/n/actions/runs/1", observedAt: "" };
    expect(isLiveFinding({ kind: "ci_rot", evidence: [file] })).toBe(false);
    expect(isLiveFinding({ kind: "ci_rot", evidence: [run] })).toBe(true);
    expect(isLiveFinding({ kind: "issue", evidence: [file] })).toBe(true);
    expect(isLiveFinding({ kind: "tech_debt", evidence: [file] })).toBe(false);
  });
});
