import { describe, expect, it } from "vitest";
import type { Commit } from "../src/git/repo.ts";
import { busFactor, computeActivity, firstResponseHours } from "../src/profile/activity.ts";
import type { GitHubSamples, IssueSample } from "../src/github/types.ts";
import { branchPattern, inferConventions } from "../src/profile/conventions.ts";

const commit = (subject: string, authorEmail = "a@x"): Commit => ({ sha: "s", authorEmail, authorName: "A", date: "2026-01-01T00:00:00Z", subject, files: [] });

describe("conventions", () => {
  it("detects conventional commits and reports recent subjects", () => {
    const commits = ["feat: a", "fix(core): b", "docs: c", "chore: d", "feat!: e", "Update README"].map((s) => commit(s));
    const c = inferConventions(commits, undefined, []);
    expect(c.commitStyle).toBe("conventional");
    expect(c.recentCommitSubjects).toHaveLength(6);
    expect(inferConventions(["Fix bug", "Add thing", "wip", "more", "stuff"].map((s) => commit(s)), undefined, []).commitStyle).toBe("freeform");
    expect(inferConventions([commit("x")], undefined, []).commitStyle).toBe("unknown");
  });

  it("describes dominant branch naming", () => {
    expect(branchPattern(["fix/a", "feat/b", "fix/c", "docs/d", "random"])).toBe("fix/<topic>, feat/<topic>, docs/<topic>");
    expect(branchPattern(["123-fix", "gh-45-thing", "issue-9-x"])).toBe("<issue-number>-<topic>");
    expect(branchPattern(["a", "b"])).toBeUndefined();
  });
});

describe("activity helpers", () => {
  it("computes bus factor as authors covering half the commits", () => {
    const commits = [...Array(6).fill("a@x"), ...Array(3).fill("b@x"), "c@x"].map((e: string) => commit("s", e));
    expect(busFactor(commits)).toBe(1);
    expect(busFactor([commit("s", "a@x"), commit("s", "b@x"), commit("s", "c@x"), commit("s", "d@x")])).toBe(2);
    expect(busFactor([])).toBe(0);
  });

  it("leaves issues with unfetched comments out of response statistics", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    const base: IssueSample = { number: 1, title: "t", url: "u", body: "", createdAt: "2022-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", closedAt: undefined, locked: false, author: { login: "a", isBot: false }, association: "NONE", labels: [], assignees: [], reactions: 0, commentCount: 5, firstComments: [], lastComments: [], linkedPrs: [] };
    const answered: IssueSample = { ...base, number: 2, createdAt: "2026-10-01T00:00:00Z", commentCount: 1, firstComments: [{ createdAt: "2026-10-02T00:00:00Z", author: { login: "m", isBot: false }, association: "MEMBER", body: undefined }] };
    const samples: GitHubSamples = { isMirror: false, openIssueCount: 2, openPrCount: 0, labels: [], openIssues: [base, answered], closedIssues: [], openPrs: [], closedPrs: [] };
    const a = computeActivity({ commits: [], samples, releases: [], pushedAt: undefined, openIssues: 2, openPrs: 0, now });
    expect(a.sampleSizes.issues).toBe(1);
    expect(a.medianIssueResponseHours).toBe(24);
  });

  it("measures first response, ignoring the author and bots, and counts long silence", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    const responses = [
      { createdAt: "2026-10-01T05:00:00Z", author: { login: "author", isBot: false } },
      { createdAt: "2026-10-01T06:00:00Z", author: { login: "bot[bot]", isBot: true } },
      { createdAt: "2026-10-02T00:00:00Z", author: { login: "maint", isBot: false } },
    ];
    expect(firstResponseHours("2026-10-01T00:00:00Z", "author", responses, now)).toBe(24);
    expect(firstResponseHours("2026-10-01T00:00:00Z", "author", [], now)).toBe(21 * 24);
    expect(firstResponseHours("2026-10-21T00:00:00Z", "author", [], now)).toBeUndefined();
  });

  it("ends the wait at a merge, which answers, or at a close, which only stops the clock", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    expect(firstResponseHours("2026-09-01T00:00:00Z", "author", [], now, "2026-09-01T02:00:00Z", "2026-09-01T02:00:00Z")).toBe(2);
    expect(firstResponseHours("2026-09-01T00:00:00Z", "author", [{ createdAt: "2026-09-01T05:00:00Z", author: { login: "maint", isBot: false } }], now, "2026-09-01T02:00:00Z", "2026-09-01T02:00:00Z")).toBe(2);
    expect(firstResponseHours("2026-09-01T00:00:00Z", "author", [], now, "2026-09-11T00:00:00Z")).toBe(240);
    // Closed a day later with no reply: maybe by its author, so no evidence either way.
    expect(firstResponseHours("2026-09-01T00:00:00Z", "author", [], now, "2026-09-02T00:00:00Z")).toBeUndefined();
  });

  it("does not report outside PRs merged within hours as waiting a month", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const pr = (n: number) => ({ number: n, title: `fix ${n}`, url: `u${n}`, state: "MERGED", isDraft: false, merged: true, mergedAt: `2026-09-0${n}T02:00:00Z`, closedAt: `2026-09-0${n}T02:00:00Z`, createdAt: `2026-09-0${n}T00:00:00Z`, updatedAt: `2026-09-0${n}T02:00:00Z`, mergeable: "UNKNOWN", author: { login: `c${n}`, isBot: false }, association: "CONTRIBUTOR", additions: 1, deletions: 1, changedFiles: 1, headRefName: "x", labels: [], closingIssues: [], firstComments: [], lastComments: [], reviews: [] });
    const samples = { isMirror: false, openIssueCount: 0, openPrCount: 0, labels: [], openIssues: [], closedIssues: [], openPrs: [], closedPrs: [1, 2, 3, 4, 5].map(pr) };
    expect(computeActivity({ commits: [], samples: samples as never, releases: [], pushedAt: undefined, openIssues: 0, openPrs: 0, now }).medianPrResponseHours).toBe(2);
  });
});
