import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitMessage, publishPullRequest, pullRequestBody, pullRequestTitle, type DeliveryInput } from "../src/deliver.ts";
import { git } from "../src/workspace.ts";
import { subjectFor, usesConventionalCommits } from "../src/naming.ts";
import { TaskSchema, type Task } from "../src/types.ts";

const base: Task = TaskSchema.parse({
  id: "x",
  repo: { owner: "acme", name: "widgets" },
  kind: "issue",
  title: "Fix off-by-one in paginate() so the last item is included",
  summary: "paginate() drops the last item of the final page.",
  issue: { number: 42 },
});

const input = (task: Task): DeliveryInput => ({
  task,
  plan: { goal: "Include the final item in the last page", steps: ["adjust the upper bound", "add a regression test"], filesToModify: ["src/paginate.ts"], filesToCreate: [], testsToAdd: ["last page"], outOfScope: [], risks: [], needsNewDependency: false },
  notes: { summary: "Changed `<` to `<=` in the slice bound.", deviationsFromPlan: [], testsRun: ["npm test"], knownGaps: ["No benchmark was run."], done: true },
  verification: { checks: [{ name: "test", command: "npm test", status: "pass", exitCode: 0, durationMs: 1200, outputTail: "" }], regressions: [], ok: true, diff: { files: 2, insertions: 5, deletions: 1, changedFiles: ["src/paginate.ts", "test/paginate.test.ts"] } },
  review: { verdict: "approve", checks: [], findings: [{ severity: "nit", file: "src/paginate.ts", line: 3, summary: "Consider a named constant", failureScenario: "", suggestion: "" }], prNotes: "" },
  template: "## Description\n\n- [ ] Tests added\n- [x] Docs updated\n",
});

describe("conventional commit detection", () => {
  it("uses intel's hint first, then recent subjects", () => {
    expect(usesConventionalCommits({ ...base, conventions: { ...base.conventions, commitStyle: "conventional" } })).toBe(true);
    expect(usesConventionalCommits({ ...base, conventions: { ...base.conventions, recentCommitSubjects: ["fix: a", "feat(x): b", "Merge pull request"] } })).toBe(true);
    expect(usesConventionalCommits({ ...base, conventions: { ...base.conventions, recentCommitSubjects: ["Update README", "Fix bug"] } })).toBe(false);
    expect(usesConventionalCommits({ ...base, conventions: { ...base.conventions, commitStyle: "unknown", recentCommitSubjects: ["fix: a", "feat: b"] } })).toBe(true);
    expect(usesConventionalCommits({ ...base, conventions: { ...base.conventions, commitStyle: "freeform", recentCommitSubjects: ["fix: a", "feat: b"] } })).toBe(false);
  });
});

describe("subjectFor", () => {
  it("formats conventional subjects from the kind", () => {
    const task = { ...base, conventions: { ...base.conventions, commitStyle: "conventional" } };
    expect(subjectFor(task, "Include the final item in the last page")).toBe("fix: include the final item in the last page");
    expect(subjectFor({ ...task, kind: "docs_drift" }, undefined)).toMatch(/^docs: fix off-by-one/);
  });
  it("keeps plain subjects capitalised and under 72 characters", () => {
    const long = "x".repeat(100);
    expect(subjectFor(base, long).length).toBeLessThanOrEqual(72);
    expect(subjectFor(base, "include the final item")).toBe("Include the final item");
  });
});

describe("pull request text", () => {
  it("builds a commit message with a body and issue reference", () => {
    const m = commitMessage(input(base));
    expect(m.split("\n")[0]).toBe("Include the final item in the last page");
    expect(m).toContain("Refs #42");
  });
  it("writes a structured PR body with evidence and the template checklist", () => {
    const body = pullRequestBody(input(base));
    expect(body).toContain("Fixes #42");
    expect(body).toContain("| `npm test` | pass |");
    expect(body).toContain("## Changes\nChanged `<` to `<=` in the slice bound.");
    expect(body).toContain("- No benchmark was run.");
    expect(body).toContain("Reviewer note (nit): Consider a named constant");
    expect(body).toContain("- [ ] Tests added");
    expect(body).toContain("- [ ] Docs updated");
    expect(body).toContain("a human reviewed this change");
    expect(pullRequestTitle(input(base))).toBe("Include the final item in the last page");
  });
  it("uses Refs instead of Fixes for non-fix kinds", () => {
    expect(pullRequestBody(input({ ...base, kind: "docs_drift" }))).toContain("Refs #42");
  });
});

describe("publishPullRequest", () => {
  it("plans a fork, push and draft PR in dry-run mode without touching the network", async () => {
    const delivery = { branch: "gitgoblin/fix-42", commitSha: "abc123", commitMessage: "m", prTitle: "T", prBody: "B" };
    const result = await publishPullRequest({ task: base, delivery, wsPath: process.cwd(), bodyFile: "pr.md", env: {}, dryRun: true });
    expect(result.commands).toEqual([
      "gh repo fork acme/widgets --clone=false",
      "git -c credential.helper= -c credential.helper=!gh auth git-credential push https://github.com/<login>/widgets.git abc123:refs/heads/gitgoblin/fix-42",
      "gh pr create --repo acme/widgets --base main --head <login>:gitgoblin/fix-42 --title T --body-file pr.md --draft",
    ]);
  });
  it("refuses to publish anything but the prepared commit, before touching the network", async () => {
    const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const repo = mkdtempSync(path.join(os.tmpdir(), "gg-pub-"));
    await git(["init", "-q", "-b", "main"], repo, env);
    writeFileSync(path.join(repo, "a"), "1");
    await git(["add", "."], repo, env);
    await git(["commit", "-q", "-m", "one"], repo, env);
    const delivery = { branch: "main", commitSha: "0".repeat(40), commitMessage: "m", prTitle: "T", prBody: "B" };
    await expect(publishPullRequest({ task: base, delivery, wsPath: repo, bodyFile: "pr.md", env })).rejects.toThrow(/not the prepared commit/);
    const head = await git(["rev-parse", "HEAD"], repo, env);
    writeFileSync(path.join(repo, "a"), "2");
    await expect(publishPullRequest({ task: base, delivery: { ...delivery, commitSha: head }, wsPath: repo, bodyFile: "pr.md", env })).rejects.toThrow(/uncommitted changes/);
  });
  it("refuses hosts other than GitHub", async () => {
    const task = { ...base, repo: { ...base.repo, host: "gitlab.com" } };
    await expect(publishPullRequest({ task, delivery: { branch: "b", commitSha: "", commitMessage: "", prTitle: "", prBody: "" }, wsPath: process.cwd(), bodyFile: "x", env: {}, dryRun: true })).rejects.toThrow(/gitlab.com/);
  });
});
