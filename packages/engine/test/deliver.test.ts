import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitMessage, neutralizeForGitHub, publishPullRequest, pullRequestBody, pullRequestTitle, type DeliveryInput } from "../src/deliver.ts";
import { git } from "../src/workspace.ts";
import { branchNameFor, subjectFor, usesConventionalCommits } from "../src/naming.ts";
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
      "gh api repos/acme/widgets/pulls?head=<login>:gitgoblin/fix-42&state=open&per_page=1 --jq .[0].html_url // empty",
      "gh pr create --repo acme/widgets --base main --head <login>:gitgoblin/fix-42 --title T --body-file pr.md --draft",
    ]);
  });

  describe("after a partial failure", () => {
    // A publish that pushed but lost the answer to `gh pr create` is retried by the person; GitHub
    // refuses a second pull request for the same branch, so the retry must find the first one.
    const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    async function preparedRepo() {
      const repo = mkdtempSync(path.join(os.tmpdir(), "gg-pub-"));
      await git(["init", "-q", "-b", "main"], repo, env);
      writeFileSync(path.join(repo, "a"), "1");
      await git(["add", "."], repo, env);
      await git(["commit", "-q", "-m", "one"], repo, env);
      return { repo, sha: await git(["rev-parse", "HEAD"], repo, env) };
    }
    const fakeRunner = (existing: string, calls: string[]) => ({
      gh: async (args: string[]) => {
        calls.push(`gh ${args.join(" ")}`);
        if (args[0] === "api" && args[1] === "user") return "octo";
        if (args[0] === "repo" && args[1] === "view") return "WRITE";
        if (args[0] === "api" && String(args[1]).includes("/pulls?head=")) return existing;
        if (args[0] === "pr" && args[1] === "create") return "https://github.com/acme/widgets/pull/99";
        return "";
      },
      push: async (args: string[]) => {
        calls.push(`git ${args.join(" ")}`);
        return "";
      },
    });

    it("reuses the pull request a previous attempt opened instead of failing", async () => {
      const { repo, sha } = await preparedRepo();
      const calls: string[] = [];
      const lines: string[] = [];
      const delivery = { branch: "gitgoblin/fix-42", commitSha: sha, commitMessage: "m", prTitle: "T", prBody: "B" };
      const result = await publishPullRequest({ task: base, delivery, wsPath: repo, bodyFile: "pr.md", env, runner: fakeRunner("https://github.com/acme/widgets/pull/7", calls), log: (l) => lines.push(l) });
      expect(result.url).toBe("https://github.com/acme/widgets/pull/7");
      expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
      expect(calls.some((c) => c.includes("pulls?head=acme:gitgoblin/fix-42"))).toBe(true);
      expect(lines.join("\n")).toMatch(/already open/);
    });

    it("opens a pull request when none is open for the branch", async () => {
      const { repo, sha } = await preparedRepo();
      const calls: string[] = [];
      const delivery = { branch: "gitgoblin/fix-42", commitSha: sha, commitMessage: "m", prTitle: "T", prBody: "B" };
      const result = await publishPullRequest({ task: base, delivery, wsPath: repo, bodyFile: "pr.md", env, runner: fakeRunner("", calls) });
      expect(result.url).toBe("https://github.com/acme/widgets/pull/99");
      expect(calls.filter((c) => c.startsWith("gh pr create"))).toHaveLength(1);
    });
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

describe("neutralizeForGitHub", () => {
  it("turns mentions into code so nobody is pinged by text the model wrote", () => {
    expect(neutralizeForGitHub("thanks @octocat and @acme/maintainers")).toBe("thanks `@octocat` and `@acme/maintainers`");
    expect(neutralizeForGitHub("mail me at dev@example.com")).toBe("mail me at dev@example.com");
    expect(neutralizeForGitHub("already `@quoted`")).toBe("already `@quoted`");
  });
  it("keeps closing keywords from closing issues the change was not about", () => {
    expect(neutralizeForGitHub("Closes #12 and fixes #40")).toBe("Closes `#12` and fixes `#40`");
    expect(neutralizeForGitHub("resolves acme/other#3")).toBe("resolves `acme/other#3`");
    expect(neutralizeForGitHub("fixed: https://github.com/acme/widgets/issues/9")).toBe("fixed: `https://github.com/acme/widgets/issues/9`");
    expect(neutralizeForGitHub("see #12 for context")).toBe("see #12 for context");
  });
  it("leaves ordinary prose alone", () => {
    expect(neutralizeForGitHub("Changed `<` to `<=` in the slice bound.")).toBe("Changed `<` to `<=` in the slice bound.");
  });
});

describe("pull request text from untrusted sources", () => {
  const hostile = (task: Task): DeliveryInput => {
    const i = input(task);
    return {
      ...i,
      notes: { ...i.notes, summary: "Fixed it. Closes #1, closes #2. cc @maintainer", knownGaps: ["ask @someone"] },
      review: { ...i.review, prNotes: "fixes #3", findings: [{ severity: "minor", file: "src/paginate.ts", line: null, summary: "ping @bob", failureScenario: "", suggestion: "" }] },
    };
  };
  it("keeps the engine's own issue link working and neutralizes everything the model wrote", () => {
    const body = pullRequestBody(hostile(base));
    expect(body).toContain("Fixes #42");
    expect(body).not.toMatch(/(^|[^`])#1\b/);
    expect(body).toContain("closes `#2`");
    expect(body).toContain("`@maintainer`");
    expect(body).toContain("`@someone`");
    expect(body).toContain("`@bob`");
    expect(body).toContain("fixes `#3`");
    const message = commitMessage(hostile(base));
    expect(message).toContain("Refs #42");
    expect(message).toContain("Closes `#1`");
    expect(message).not.toMatch(/(^|[^`])@maintainer/);
  });
});

describe("pull request text from a real run (eslint-plugin-testing-library #1401)", () => {
  // Shapes taken from the end-to-end replay of live run 4.
  const real = TaskSchema.parse({
    id: "opp-6fa0e219",
    repo: { owner: "testing-library", name: "eslint-plugin-testing-library" },
    kind: "issue",
    title: "Fix #1401: `no-wait-for-side-effects`: autofix breaks code when the `waitFor` callback is on one line",
    summary: "Have you read the Troubleshooting section? Yes Plugin version 7.16.2 ESLint version 10.12.0 Node.js version 22.23.1 Bug description The autofix seems to work line by line.",
    issue: { number: 1401 },
    conventions: { commitStyle: "conventional" },
  });
  const realInput = (): DeliveryInput => {
    const i = input(real);
    return {
      ...i,
      plan: { ...i.plan, goal: "Make the no-wait-for-side-effects autofix correct when the waitFor callback shares a line with other code" },
      notes: {
        ...i.notes,
        summary: "The autofix now gives correct code when the callback shares a line (#1401).",
        knownGaps: [
          "Several side effects on the same line are fixed over several ESLint passes.",
          "There is an untracked `.pnpm-store/` directory in the workspace. It is not part of the change.",
          "No maintainer has confirmed #1401 yet. I have not commented on the issue or opened a PR, because I can't reach the network.",
        ],
        deviationsFromPlan: ["I ran vitest from ./node_modules/.bin instead of through `pnpm`, which failed in this sandbox with ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK."],
        environmentNotes: ["pnpm could not take its store lock in the sandbox."],
      },
    };
  };

  it("titles the change without repeating the verb or the issue number", () => {
    const title = pullRequestTitle(realInput());
    expect(title).not.toMatch(/fix: fix/i);
    expect(title).not.toContain("#1401");
    expect(title).toMatch(/^fix: /);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(branchNameFor(real)).toBe("gitgoblin/fix-1401-no-wait-for-side-effects");
  });

  it("summarises with the plan's goal, not the issue template text", () => {
    const body = pullRequestBody(realInput());
    expect(body).not.toContain("Have you read the Troubleshooting section");
    expect(body).toContain("Make the no-wait-for-side-effects autofix correct");
    expect(body).toContain("Fixes #1401");
  });

  it("keeps the task's own issue linkable while still inerting others", () => {
    const body = pullRequestBody(realInput());
    expect(body).toContain("(#1401)");
    expect(body).not.toContain("`#1401`");
  });

  it("keeps notes about the engine's own environment out of the public body", () => {
    const body = pullRequestBody(realInput());
    expect(body).toContain("Several side effects on the same line");
    expect(body).not.toMatch(/sandbox|ERR_PNPM|\.pnpm-store|can't reach the network|store lock/i);
  });
});

describe("pull request text, run 5 findings", () => {
  const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n" }, kind: "issue", title: "Fix #9: crash on empty input", issue: { number: 9 }, conventions: { commitStyle: "conventional" } });
  const base = (): DeliveryInput => ({
    ...input(task),
    plan: { ...input(task).plan, goal: "Handle empty input without crashing", commitSubject: "fix(parser): handle empty input without crashing" },
    investigation: { summary: "", relevantFiles: [], rootCause: "parse() indexes the first token without checking the list is empty", reproduction: { kind: "none", path: "", command: "", observed: "" }, commands: {}, feasibility: "proceed", reasons: [], questions: [] },
    verification: {
      checks: [
        { name: "build", command: "pnpm build", status: "fail", exitCode: 1, durationMs: 1, outputTail: "" },
        { name: "test", command: "pnpm test", status: "pass", exitCode: 0, durationMs: 1, outputTail: "" },
      ],
      regressions: [],
      ok: true,
      diff: { files: 1, insertions: 1, deletions: 0, changedFiles: ["src/parse.ts"] },
      preexisting: ["build"],
    },
    review: {
      verdict: "approve",
      checks: [],
      findings: [
        { severity: "nit", file: ".pnpm-store", line: null, summary: "An untracked .pnpm-store directory is present", failureScenario: "", suggestion: "" },
        { severity: "nit", file: "src/parse.ts", line: 3, summary: "Consider an early return", failureScenario: "", suggestion: "" },
      ],
      prNotes: "I recommend approving. I could not run the tests myself because the review hook blocked it.",
    },
  });

  it("uses the planner's subject when it fits", () => {
    expect(pullRequestTitle(base())).toBe("fix(parser): handle empty input without crashing");
    expect(commitMessage(base()).split("\n")[0]).toBe("fix(parser): handle empty input without crashing");
  });

  it("explains the change with the goal and the root cause", () => {
    expect(pullRequestBody(base())).toContain("Handle empty input without crashing. parse() indexes the first token without checking the list is empty.");
  });

  it("marks checks that already failed on the base commit", () => {
    const body = pullRequestBody(base());
    expect(body).toContain("| `pnpm build` | fail (also fails on the base commit) |");
    expect(body).toContain("| `pnpm test` | pass |");
  });

  it("gives the test counts for a suite that already failed", () => {
    const input = base();
    input.verification = {
      ...input.verification,
      checks: [{ name: "test", command: "pnpm test", status: "fail", exitCode: 1, durationMs: 1, outputTail: "", tests: { failed: 7, passed: 5292 } }],
      preexisting: ["test"],
      testCounts: [{ name: "test", baseline: { failed: 7, passed: 5290 }, now: { failed: 7, passed: 5292 } }],
    };
    expect(pullRequestBody(input)).toContain("| `pnpm test` | fail (also fails on the base commit: 7 failing and 5292 passing tests, against 7 and 5290 on the base commit) |");
  });

  it("keeps reviewer notes about the change and drops ones about the workspace or addressed to the operator", () => {
    const body = pullRequestBody(base());
    expect(body).toContain("Consider an early return");
    expect(body).not.toContain(".pnpm-store");
    expect(body).not.toMatch(/recommend approving|review hook/i);
    expect(body).not.toContain("Deviation from plan");
  });
});

describe("pull request text, run 6 findings", () => {
  const task = TaskSchema.parse({
    id: "opp-6fa0e219",
    repo: { owner: "testing-library", name: "eslint-plugin-testing-library" },
    kind: "issue",
    title: "Fix #1401: `no-wait-for-side-effects`: autofix breaks code when the `waitFor` callback is on one line",
    issue: { number: 1401 },
    conventions: { commitStyle: "conventional" },
  });
  const run6 = (commitSubject?: string): DeliveryInput => {
    const i = input(task);
    return {
      ...i,
      plan: { ...i.plan, goal: "Make the no-wait-for-side-effects autofix produce valid code when the waitFor callback is on one line", ...(commitSubject ? { commitSubject } : {}) },
      notes: {
        ...i.notes,
        knownGaps: [
          "A comment between the side effect and the next token on the same line is deleted by the fix.",
          "The moved side effect is separated from the rest of the line by a single space, which Prettier may reformat.",
        ],
      },
      verification: { ...i.verification, diff: { ...i.verification.diff, changedFiles: ["src/rules/no-wait-for-side-effects.ts"] } },
      review: {
        verdict: "approve",
        checks: [],
        findings: [
          { severity: "nit", file: "src/rules/no-wait-for-side-effects.ts", line: 40, summary: "A comment between the side effect and the next token on that line gets deleted by the fix.", failureScenario: "", suggestion: "" },
          { severity: "nit", file: "src/rules/no-wait-for-side-effects.ts", line: 52, summary: "Name the token helper after what it checks.", failureScenario: "", suggestion: "" },
        ],
        prNotes: "The moved side effect is joined to the rest of the line with a single space; Prettier may reformat it.",
      },
    };
  };

  it("drops the scope from a proposed subject that is too long rather than discarding it", () => {
    expect(pullRequestTitle(run6("fix(no-wait-for-side-effects): handle single-line waitFor callbacks in autofix"))).toBe("fix: handle single-line waitFor callbacks in autofix");
  });

  it("falls back to the goal's words, not the bug report's, and never clips mid-phrase when it can avoid it", () => {
    const title = pullRequestTitle(run6());
    expect(title).not.toContain("breaks code");
    expect(title.endsWith("…")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toMatch(/^fix: make the no-wait-for-side-effects autofix produce valid code/);
  });

  it("does not repeat a known gap as a reviewer note or in the reviewer's notes", () => {
    const body = pullRequestBody(run6());
    expect(body.match(/comment between the side effect/gi)?.length).toBe(1);
    expect(body.match(/single space/gi)?.length).toBe(1);
    expect(body).toContain("Name the token helper");
  });
});

describe("pull request text, run 7 findings", () => {
  const task = TaskSchema.parse({
    id: "x", repo: { owner: "o", name: "n" }, kind: "issue", title: "t", issue: { number: 3 },
    risks: ["No maintainer has confirmed the issue yet."],
  });
  it("keeps the task's risks, which are for the operator, out of the pull request", () => {
    const i = input(task);
    const body = pullRequestBody({
      ...i,
      notes: { ...i.notes, knownGaps: ["No maintainer has confirmed the issue yet.", "Tabs in the moved line are kept as they were."] },
      review: { ...i.review, prNotes: "Nobody from the maintainers has confirmed this issue so far." },
    });
    expect(body).not.toMatch(/confirmed/i);
    expect(body).toContain("Tabs in the moved line");
  });
});

describe("invisible characters in what gets published", () => {
  it("strips bidi, zero-width and control characters from the title, body and commit message", () => {
    const i = input(base);
    const tricky = { ...i, template: "- [ ] I signed the CLA\u202e\u200b \u001b[8mhidden\n", notes: { ...i.notes, summary: "Fixed\u2066 it\u2069.\u0007" } };
    const body = pullRequestBody(tricky);
    const message = commitMessage(tricky);
    for (const text of [body, message, pullRequestTitle(tricky)]) {
      expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
    }
    expect(body).toContain("I signed the CLA");
  });
});
