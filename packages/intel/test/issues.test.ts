import { describe, expect, it } from "vitest";
import { assessIssue, plainText } from "../src/analyzers/issues.ts";
import { assessStalePr } from "../src/analyzers/stale-prs.ts";
import type { CommentSample, IssueSample, PrSample } from "../src/github/types.ts";

const now = new Date("2026-10-22T00:00:00Z");
const REPO = "https://github.com/o/r";

function comment(body: string, over: Partial<CommentSample> = {}): CommentSample {
  return { createdAt: "2026-09-01T00:00:00Z", author: { login: "someone", isBot: false }, association: "NONE", body, ...over };
}

function issue(over: Partial<IssueSample> = {}): IssueSample {
  return {
    number: 1, title: "Crash when input is empty", url: `${REPO}/issues/1`, body: "Steps to reproduce:\n1. run\n```\nTraceback (most recent call last)\n```",
    createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", closedAt: undefined, locked: false,
    author: { login: "reporter", isBot: false }, association: "NONE", labels: [], assignees: [], reactions: 0, commentCount: 0,
    firstComments: [], lastComments: [], linkedPrs: [], ...over,
  };
}

describe("assessIssue", () => {
  it("accepts a bug with a reproduction and no sign of work", () => {
    const a = assessIssue(issue(), now, true, REPO);
    expect(a.skipReason).toBeUndefined();
    expect(a.kind).toBe("issue");
    expect(a.hasRepro).toBe(true);
    expect(a.novelty).toBe(0.9);
  });

  it("skips questions, negative labels, maintainer pushback and merged fixes", () => {
    expect(assessIssue(issue({ title: "[Query] How to propagate the error message?" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ title: "How do I configure retries?" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ title: "How do I configure retries?", labels: ["bug"] }), now, true, REPO).skipReason).toBeUndefined();
    expect(assessIssue(issue({ title: "I need help to remove entries from history" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ title: "Use vim as previewer" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ title: "Weird output", body: "Hi, how can I make the output wider? Here is my config:\n```\nfoo\n```" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ labels: ["wontfix"] }), now, true, REPO).skipReason).toMatch(/wontfix/);
    expect(assessIssue(issue({ lastComments: [comment("This is working as intended, closing.", { association: "OWNER" })] }), now, true, REPO).skipReason).toMatch(/pushed back/);
    expect(assessIssue(issue({ linkedPrs: [{ number: 9, url: `${REPO}/pull/9`, state: "MERGED", isDraft: false, updatedAt: "2026-09-01T00:00:00Z" }] }), now, true, REPO).skipReason).toMatch(/merged/);
  });

  it("uses the newest same-repository PR to judge in-flight work and ignores other repositories", () => {
    const prs = [
      { number: 30, url: `${REPO}/pull/30`, state: "OPEN" as const, isDraft: false, updatedAt: "2026-01-01T00:00:00Z" },
      { number: 40, url: `${REPO}/pull/40`, state: "OPEN" as const, isDraft: false, updatedAt: "2026-10-01T00:00:00Z" },
    ];
    expect(assessIssue(issue({ linkedPrs: prs }), now, true, REPO)).toMatchObject({ novelty: 0.05, noveltyReason: expect.stringContaining("#40") });
    expect(assessIssue(issue({ linkedPrs: [prs[0]!] }), now, true, REPO)).toMatchObject({ novelty: 0.45 });
    const foreign = [{ number: 11875, url: "https://github.com/other/repo/pull/11875", state: "OPEN" as const, isDraft: false, updatedAt: "2026-10-01T00:00:00Z" }];
    expect(assessIssue(issue({ linkedPrs: foreign }), now, true, REPO).novelty).toBe(0.9);
  });

  it("lowers novelty for assignees and recent claims, but recovers for stale claims", () => {
    expect(assessIssue(issue({ assignees: ["dev"] }), now, true, REPO).novelty).toBe(0.2);
    const recent = comment("I'd like to work on this!", { createdAt: "2026-10-10T00:00:00Z" });
    const old = comment("Can I take this one?", { createdAt: "2026-03-01T00:00:00Z" });
    expect(assessIssue(issue({ lastComments: [recent] }), now, true, REPO).novelty).toBe(0.2);
    expect(assessIssue(issue({ lastComments: [old] }), now, true, REPO).novelty).toBe(0.75);
  });

  it("requires endorsement for feature requests and routes unanswered vague issues to triage", () => {
    for (const t of ["Make express.static use the etag setting", "A flag for words that might be on different lines", "Propuesta: wrapper nativo", "Restore support for app.all('*')", "ETag should consider CORS headers"]) {
      expect(assessIssue(issue({ title: t, body: "Please." }), now, true, REPO).kind, t).toBe("feature_request");
    }
    const feature = issue({ title: "Add support for jitter", labels: ["enhancement"], body: "It would be nice." });
    expect(assessIssue(feature, now, true, REPO)).toMatchObject({ kind: "feature_request", skipReason: expect.stringContaining("endorsement") });
    const endorsed = { ...feature, lastComments: [comment("Sounds good, PRs welcome!", { association: "MEMBER" })] };
    const e = assessIssue(endorsed, now, true, REPO);
    expect(e.kind).toBe("feature_request");
    expect(e.skipReason).toBeUndefined();
    expect(assessIssue(issue({ title: "Large sums of wait strategies raise RecursionError", body: "short" }), now, true, REPO).kind).toBe("issue");
    expect(assessIssue(issue({ title: "Unreachable code in before_log reached", body: "short" }), now, true, REPO).kind).toBe("issue");
    const vague = issue({ title: "Something odd with timing", body: "Not sure what happened." });
    expect(assessIssue(vague, now, true, REPO).kind).toBe("triage");
    expect(assessIssue(vague, now, false, REPO).skipReason).toMatch(/unclear/);
  });

  it("strips markdown from issue bodies", () => {
    expect(plainText("# Problem\nWhen **using** `x`\n```py\ncode\n```\n<!-- hidden -->done")).toBe("Problem\nWhen using x\n [code] \n done");
  });
});

describe("assessStalePr", () => {
  function pr(over: Partial<PrSample> = {}): PrSample {
    return {
      number: 5, title: "Fix leak", url: `${REPO}/pull/5`, state: "OPEN", isDraft: false, merged: false, mergedAt: undefined, closedAt: undefined,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z", mergeable: "CONFLICTING", author: { login: "ext", isBot: false }, association: "CONTRIBUTOR",
      additions: 40, deletions: 5, changedFiles: 2, headRefName: "fix-leak", labels: [], closingIssues: [3], firstComments: [], lastComments: [], reviews: [], ...over,
    };
  }
  it("revives approved or update-requested PRs whose authors went quiet", () => {
    const approved = [{ state: "APPROVED", createdAt: "2026-04-01T00:00:00Z", author: { login: "m", isBot: false }, association: "MEMBER" }];
    expect(assessStalePr(pr({ reviews: approved }), now)).toMatchObject({ eligible: true, approved: true, reason: "approved but now conflicting" });
    expect(assessStalePr(pr({ reviews: approved, mergeable: "MERGEABLE" }), now)).toMatchObject({ eligible: false, reason: expect.stringContaining("waiting on maintainers") });
    expect(assessStalePr(pr({ lastComments: [comment("Needs a rebase, could you update?", { association: "OWNER", author: { login: "owner", isBot: false } })] }), now).eligible).toBe(true);
    expect(assessStalePr(pr(), now)).toMatchObject({ eligible: false, reason: expect.stringContaining("no sign") });
    expect(assessStalePr(pr({ updatedAt: "2026-10-01T00:00:00Z" }), now).eligible).toBe(false);
    expect(assessStalePr(pr({ isDraft: true }), now).eligible).toBe(false);
  });
});
