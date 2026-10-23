import { describe, expect, it } from "vitest";
import type { Commit } from "../src/git/repo.ts";
import { busFactor, firstResponseHours } from "../src/profile/activity.ts";
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
});
