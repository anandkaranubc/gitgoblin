import { describe, expect, it } from "vitest";
import { assessIssue, findNearDuplicate, looksLikeRequestTitle, plainText } from "../src/analyzers/issues.ts";
import { assessStalePr } from "../src/analyzers/stale-prs.ts";
import type { CommentSample, IssueSample, PrSample, ReviewSample } from "../src/github/types.ts";

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
    expect(assessIssue(issue({ title: "How do I configure retries?", labels: ["bug", "confirmed"] }), now, true, REPO).skipReason).toBeUndefined();
    expect(assessIssue(issue({ title: "My app is not working", labels: ["bug"] }), now, true, REPO).skipReason).toMatch(/question|template/);
    expect(assessIssue(issue({ title: "error", labels: ["bug"] }), now, true, REPO).skipReason).toMatch(/template-applied/);
    expect(assessIssue(issue({ title: "I can't open captcha on captcha job", labels: ["bug"] }), now, true, REPO).skipReason).toMatch(/question/);
    const needsInfo = assessIssue(issue({ labels: ["bug", "needs-info"], lastComments: [comment("please share a repro", { association: "MEMBER" }), comment("still broken"), comment("any news")] }), now, true, REPO);
    expect(needsInfo.skipReason).toMatch(/waiting on the reporter/);
    expect(assessIssue(issue({ labels: ["bug", "needs-info"] }), now, true, REPO).kind).toBe("triage");
    expect(assessIssue(issue({ title: "I need help to remove entries from history" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ title: "Use vim as previewer" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ title: "Weird output", body: "Hi, how can I make the output wider? Here is my config:\n```\nfoo\n```" }), now, true, REPO).skipReason).toMatch(/question/);
    expect(assessIssue(issue({ labels: ["wontfix"] }), now, true, REPO).skipReason).toMatch(/wontfix/);
    expect(assessIssue(issue({ labels: ["discuss"] }), now, true, REPO).skipReason).toMatch(/discuss/);
    expect(assessIssue(issue({ labels: ["p5-wont-fix ☮"] }), now, true, REPO).skipReason).toMatch(/wont-fix/);
    expect(assessIssue(issue({ title: "urllib3 Retry and Response Hooks (Duplicates #4514)" }), now, true, REPO).skipReason).toMatch(/duplicate/);
    expect(assessIssue(issue({ title: "Duplicate detection fails on empty keys" }), now, true, REPO).skipReason).toBeUndefined();
    expect(assessIssue(issue({ labels: ["to-merge ↰"] }), now, true, REPO).novelty).toBe(0.1);
    expect(assessIssue(issue({ title: "Enhancement: Include the file name in parse error messaging", labels: ["feature request"], body: "Please." }), now, true, REPO).kind).toBe("feature_request");
    expect(assessIssue(issue({ title: "Enhancement: Include the file name in parse error messaging", labels: ["feature request", "bug"], body: "Please." }), now, true, REPO).kind).toBe("issue");
    const quoted = issue({ lastComments: [comment("> this is working as intended?\n\nNo, I can reproduce it, PRs welcome.", { association: "OWNER" })] });
    expect(assessIssue(quoted, now, true, REPO).skipReason).toBeUndefined();
    expect(assessIssue(issue({ lastComments: [comment("This is working as intended, closing.", { association: "OWNER" })] }), now, true, REPO).skipReason).toMatch(/pushed back/);
    expect(assessIssue(issue({ lastComments: [comment("Please provide a minimal reproduction.", { association: "OWNER" })] }), now, true, REPO).skipReason).toMatch(/pushed back/);
    expect(assessIssue(issue({ lastComments: [comment("Good catch, confirmed. Please provide a PR and I'll merge it.", { association: "OWNER" })] }), now, true, REPO).skipReason).toBeUndefined();
    expect(assessIssue(issue({ linkedPrs: [{ number: 9, url: `${REPO}/pull/9`, state: "MERGED", isDraft: false, updatedAt: "2026-09-01T00:00:00Z" }] }), now, true, REPO).skipReason).toMatch(/merged/);
    // An old merge plus open PRs means in flight, not resolved; a merge older than the issue cannot have fixed it.
    const mixed = [{ number: 2, url: `${REPO}/pull/2`, state: "MERGED" as const, isDraft: false, updatedAt: "2025-01-01T00:00:00Z" }, { number: 40, url: `${REPO}/pull/40`, state: "OPEN" as const, isDraft: false, updatedAt: "2026-10-01T00:00:00Z" }];
    const inFlight = assessIssue(issue({ linkedPrs: mixed }), now, true, REPO);
    expect(inFlight.skipReason).toBeUndefined();
    expect(inFlight.novelty).toBe(0.05);
    expect(assessIssue(issue({ linkedPrs: [mixed[0]!] }), now, true, REPO).skipReason).toBeUndefined();
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
    const gitlab = [{ number: 3415, url: "https://gitlab.com/o/r/-/merge_requests/3415", state: "OPEN" as const, isDraft: false, updatedAt: "2026-10-01T00:00:00Z" }];
    expect(assessIssue(issue({ linkedPrs: gitlab }), now, true, "https://gitlab.com/o/r").novelty).toBe(0.05);
  });

  it("lowers novelty for assignees and recent claims, but recovers for stale claims", () => {
    expect(assessIssue(issue({ assignees: ["dev"] }), now, true, REPO).novelty).toBe(0.2);
    const recent = comment("I'd like to work on this!", { createdAt: "2026-10-10T00:00:00Z" });
    const notAClaim = comment("I'm not sure that the Go version is working the same way, looking at it", { createdAt: "2026-10-10T00:00:00Z" });
    expect(assessIssue(issue({ lastComments: [notAClaim] }), now, true, REPO).novelty).toBe(0.9);
    expect(assessIssue(issue({ lastComments: [comment("Perhaps we should move this to the vite-plugin-vue repo.", { association: "MEMBER" })] }), now, true, REPO).skipReason).toMatch(/pushed back/);
    const old = comment("Can I take this one?", { createdAt: "2026-03-01T00:00:00Z" });
    expect(assessIssue(issue({ lastComments: [recent] }), now, true, REPO).novelty).toBe(0.2);
    expect(assessIssue(issue({ lastComments: [old] }), now, true, REPO).novelty).toBe(0.75);
  });

  it("requires endorsement for feature requests and routes unanswered vague issues to triage", () => {
    const reply = comment("same here");
    for (const t of ["Make express.static use the etag setting", "A flag for words that might be on different lines", "Propuesta: wrapper nativo", "Restore support for app.all('*')", "ETag should consider CORS headers"]) {
      expect(assessIssue(issue({ title: t, body: "Please.", lastComments: [reply] }), now, true, REPO).kind, t).toBe("feature_request");
    }
    // Unanswered, it is a triage opportunity instead of a silently dropped wish.
    expect(assessIssue(issue({ title: "Make express.static use the etag setting", body: "Please." }), now, true, REPO).kind).toBe("triage");
    const feature = issue({ title: "Add support for jitter", labels: ["enhancement"], body: "It would be nice." });
    expect(assessIssue(feature, now, true, REPO)).toMatchObject({ kind: "feature_request", skipReason: expect.stringContaining("endorsement") });
    const endorsed = { ...feature, lastComments: [comment("Sounds good, PRs welcome!", { association: "MEMBER" })] };
    const e = assessIssue(endorsed, now, true, REPO);
    expect(e.kind).toBe("feature_request");
    expect(e.skipReason).toBeUndefined();
    expect(assessIssue(issue({ title: "Large sums of wait strategies raise RecursionError", body: "short" }), now, true, REPO).kind).toBe("issue");
    expect(assessIssue(issue({ title: "Unreachable code in before_log reached", body: "short" }), now, true, REPO).kind).toBe("issue");
    expect(assessIssue(issue({ title: "Doesn't return a file with special characters %23, %2A", body: "short" }), now, true, REPO).kind).toBe("issue");
    const vague = issue({ title: "Something odd with timing", body: "Not sure what happened." });
    expect(assessIssue(vague, now, true, REPO).kind).toBe("triage");
    expect(assessIssue(vague, now, false, REPO).skipReason).toMatch(/unclear|endorsement/);
  });

  it("reads bare noun-phrase titles as requests that need endorsement", () => {
    expect(looksLikeRequestTitle("multiline PDF search")).toBe(true);
    expect(looksLikeRequestTitle("Color input fields using FZF scheme colors")).toBe(true);
    expect(looksLikeRequestTitle("fzf border not visible on Linux TTY")).toBe(false);
    expect(looksLikeRequestTitle("Unicode normalization is not performed")).toBe(false);
    expect(looksLikeRequestTitle("Zero exponential multiplier can overflow into maximum wait")).toBe(false);
    expect(looksLikeRequestTitle("`rg -o -b` reports a later match than the leftmost")).toBe(false);
    expect(looksLikeRequestTitle("SCSS: inline comment before nested function adds extra indentation")).toBe(false);
    expect(looksLikeRequestTitle("Unstable comment print in parenthesized arrow function body")).toBe(false);
    const wish = issue({ title: "multiline PDF search", body: "Steps to reproduce:\n1. open a pdf\nExpected behavior: it should search across lines. It doesn't work.", lastComments: [comment("same here")] });
    expect(assessIssue(wish, now, true, REPO)).toMatchObject({ kind: "feature_request", skipReason: expect.stringContaining("endorsement") });
  });

  it("finds near-duplicate titles among open issues", () => {
    const a = issue({ number: 1, title: "Using wildcard routes \"*\" in Express v5 causes path-to-regexp to throw" });
    const b = issue({ number: 2, title: "Wildcard routes * in Express v5 cause path-to-regexp to throw an error" });
    const c = issue({ number: 3, title: "res.json throws TypeError for BigInt values" });
    expect(findNearDuplicate(b, [a, c])?.number).toBe(1);
    expect(findNearDuplicate(c, [a, b])).toBeUndefined();
    expect(assessIssue(issue({ labels: ["Propose Close"] }), now, true, REPO).skipReason).toMatch(/Propose Close/);
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
    const approved: ReviewSample[] = [{ state: "APPROVED", createdAt: "2026-04-01T00:00:00Z", author: { login: "m", isBot: false }, association: "MEMBER" }];
    expect(assessStalePr(pr({ reviews: approved }), now)).toMatchObject({ eligible: true, approved: true, reason: "approved but now conflicting" });
    expect(assessStalePr(pr({ reviews: approved, mergeable: "MERGEABLE" }), now)).toMatchObject({ eligible: false, reason: expect.stringContaining("waiting on maintainers") });
    expect(assessStalePr(pr({ lastComments: [comment("Needs a rebase, could you update?", { association: "OWNER", author: { login: "owner", isBot: false } })] }), now).eligible).toBe(true);
    expect(assessStalePr(pr({ mergeable: "MERGEABLE", lastComments: [comment("Looks good, thank you!", { association: "OWNER", author: { login: "owner", isBot: false } })] }), now).eligible).toBe(false);
    expect(assessStalePr(pr({ mergeable: "MERGEABLE", lastComments: [comment("> could you rebase this?\n\nApproving.", { association: "OWNER", author: { login: "owner", isBot: false } })] }), now).eligible).toBe(false);
    expect(assessStalePr(pr(), now)).toMatchObject({ eligible: false, reason: expect.stringContaining("no sign") });
    expect(assessStalePr(pr({ updatedAt: "2026-10-01T00:00:00Z" }), now).eligible).toBe(false);
    expect(assessStalePr(pr({ isDraft: true }), now).eligible).toBe(false);
  });
});
