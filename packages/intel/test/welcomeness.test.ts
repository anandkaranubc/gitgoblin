import { describe, expect, it } from "vitest";
import type { Activity } from "../src/contracts.ts";
import type { GitHubSamples, PrSample, RepoMeta } from "../src/github/types.ts";
import { assessWelcomeness, extractRules, findDeprecationNotice, findRefusal, levelFor } from "../src/profile/welcomeness.ts";
import { inventoryOf } from "./helpers/inventory.ts";

const now = new Date("2026-10-22T00:00:00Z");

const meta: RepoMeta = {
  owner: "o", name: "r", defaultBranch: "main", description: undefined, homepage: undefined, topics: [], stars: 10, forks: 1,
  watchers: 1, openIssuesAndPrs: 3, license: "MIT", archived: false, disabled: false, isFork: false, isTemplate: false,
  hasIssues: true, sizeKb: 100, createdAt: "2020-01-01T00:00:00Z", pushedAt: "2026-10-01T00:00:00Z",
};

const activity: Activity = {
  lastPushAt: meta.pushedAt, commits90d: 20, commits365d: 80, authors90d: 3, authors365d: 5, busFactor: 2,
  openIssues: 3, openPullRequests: 1, sampleSizes: { issues: 0, pullRequests: 0, externalPullRequests: 0 },
};

function pr(over: Partial<PrSample>): PrSample {
  return {
    number: 1, title: "t", url: "https://github.com/o/r/pull/1", state: "MERGED", isDraft: false, merged: true,
    mergedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-01T00:00:00Z", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    mergeable: "UNKNOWN", author: { login: "ext", isBot: false }, association: "CONTRIBUTOR", additions: 10, deletions: 2, changedFiles: 1,
    headRefName: "fix/thing", labels: [], closingIssues: [], firstComments: [], lastComments: [], reviews: [], ...over,
  };
}

const samples = (over: Partial<GitHubSamples> = {}): GitHubSamples => ({
  isMirror: false, openIssueCount: 3, openPrCount: 1, labels: [], openIssues: [], closedIssues: [], openPrs: [], closedPrs: [], ...over,
});

describe("welcomeness", () => {
  it("is closed for archived repositories regardless of other signals", () => {
    const w = assessWelcomeness({ meta: { ...meta, archived: true }, samples: samples(), activity, inventory: inventoryOf(["CONTRIBUTING.md"]), docs: {}, now });
    expect(w.level).toBe("closed");
    expect(w.score).toBe(0);
    expect(w.signals[0]?.signal).toMatch(/archived/);
  });

  it("is closed when docs refuse contributions, but not when they refuse one kind", () => {
    expect(findRefusal("This project is not accepting pull requests at this time.")).toBeDefined();
    expect(findRefusal("We do not accept pull requests that only fix typos.")).toBeUndefined();
    expect(findRefusal("Please don't open PRs for new features without an issue first.")).toBeUndefined();
    expect(findRefusal("Passing Tests: Based on how much time we have, we may not review pull requests which aren't passing our tests.")).toBeUndefined();
    expect(findRefusal("We are no longer accepting pull requests for this repository.")).toBeDefined();
    expect(findRefusal("This repository is not accepting contributions.")).toBeDefined();
    const w = assessWelcomeness({ meta, samples: samples(), activity, inventory: inventoryOf(["README.md"]), docs: { readme: "Hi.\n\nWe are not accepting external contributions." }, now });
    expect(w.level).toBe("closed");
  });

  it("rewards merged outside PRs and fast responses with evidence", () => {
    const merged = Array.from({ length: 8 }, (_, i) => pr({ number: i + 1, url: `https://github.com/o/r/pull/${i + 1}`, firstComments: [{ createdAt: "2026-09-21T00:00:00Z", author: { login: "maint", isBot: false }, association: "MEMBER", body: undefined }] }));
    const w = assessWelcomeness({
      meta, samples: samples({ closedPrs: merged, labels: [{ name: "good first issue", openIssues: 4 }] }),
      activity: { ...activity, externalPrMergeRate: 1, medianPrResponseHours: 24, sampleSizes: { issues: 0, pullRequests: 8, externalPullRequests: 8 } },
      inventory: inventoryOf(["CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md"]), docs: { contributing: "Thanks for helping!" }, now,
    });
    expect(w.level).toBe("eager");
    expect(w.signals.map((s) => s.signal)).toEqual(expect.arrayContaining([
      "most outside PRs get merged", "outside PRs get a response within days", "has open issues labelled for help", "has a contributing guide",
    ]));
    for (const s of w.signals) expect(s.evidence.locator.length).toBeGreaterThan(0);
  });

  it("treats a deprecation notice as closed, but not a mention of deprecated APIs", () => {
    expect(findDeprecationNotice("# Deprecated!\n\nRequest is deprecated.", undefined)).toMatchObject({ where: "README.md" });
    expect(findDeprecationNotice("# Foo\n\nThis project is no longer maintained. Please use bar instead.", undefined)).toBeDefined();
    expect(findDeprecationNotice(undefined, "DEPRECATED: use foo-ng")).toMatchObject({ where: "repository description" });
    expect(findDeprecationNotice("# Foo\n\nFoo removes deprecated APIs from your code.", "Find deprecated functions")).toBeUndefined();
    expect(findDeprecationNotice("# Foo\n\n## Changelog\n- deprecated the old parser", undefined)).toBeUndefined();
    const w = assessWelcomeness({ meta, samples: samples(), activity, inventory: inventoryOf(["README.md"]), docs: { readme: "# DEPRECATED\n\nUse something else." }, now });
    expect(w.level).toBe("closed");
  });

  it("caps fast-but-rarely-merging repositories at selective", () => {
    const w = assessWelcomeness({
      meta, samples: samples(), inventory: inventoryOf(["CONTRIBUTING.md"]), docs: {}, now,
      activity: { ...activity, externalPrMergeRate: 0.17, medianPrResponseHours: 10, medianIssueResponseHours: 7, sampleSizes: { issues: 30, pullRequests: 40, externalPullRequests: 60 } },
    });
    expect(w.level).toBe("selective");
    expect(w.signals.at(-1)?.signal).toMatch(/capped/);
  });

  it("keeps an active but backlogged project at selective rather than dormant", () => {
    const w = assessWelcomeness({
      meta, samples: samples(), inventory: inventoryOf(["README.md"]), docs: {}, now,
      activity: { ...activity, commits90d: 4, externalPrMergeRate: 0.23, medianPrResponseHours: 24 * 104, medianIssueResponseHours: 48, sampleSizes: { issues: 30, pullRequests: 40, externalPullRequests: 48 } },
    });
    expect(w.level).toBe("selective");
  });

  it("does not call a slow-to-answer project eager even with help labels and a guide", () => {
    const w = assessWelcomeness({
      meta, samples: samples({ labels: [{ name: "help wanted", openIssues: 31 }] }), inventory: inventoryOf(["CONTRIBUTING.md"]), docs: { contributing: "Thanks" }, now,
      activity: { ...activity, externalPrMergeRate: 0.4, medianPrResponseHours: 24 * 20, medianIssueResponseHours: 24 * 103, sampleSizes: { issues: 118, pullRequests: 60, externalPullRequests: 55 } },
    });
    expect(w.level).toBe("open");
  });

  it("marks a long-silent repository dormant", () => {
    const w = assessWelcomeness({ meta: { ...meta, pushedAt: "2024-01-01T00:00:00Z" }, samples: undefined, activity: { ...activity, lastPushAt: "2024-01-01T00:00:00Z", commits365d: 0, commits90d: 0 }, inventory: inventoryOf(["README.md"]), docs: {}, now });
    expect(w.level).toBe("dormant");
  });

  it("maps scores to levels", () => {
    expect(levelFor(0)).toBe("closed");
    expect(levelFor(0.2)).toBe("dormant");
    expect(levelFor(0.4)).toBe("selective");
    expect(levelFor(0.6)).toBe("open");
    expect(levelFor(0.79)).toBe("open");
    expect(levelFor(0.9)).toBe("eager");
  });
});

describe("extractRules", () => {
  it("reads policies out of CONTRIBUTING and the PR template", () => {
    const rules = extractRules({
      inventory: inventoryOf(["CONTRIBUTING.md", ".github/pull_request_template.md", ".github/ISSUE_TEMPLATE/bug.yml", ".github/dependabot.yml"]),
      samples: samples({ labels: [{ name: "help wanted", openIssues: 2 }, { name: "bug", openIssues: 9 }] }),
      docs: {
        contributing: "Please open an issue before sending a pull request. All contributors must sign the CLA. Every change should include tests and a changelog entry. We will not merge PRs that only fix typos or whitespace.",
        prTemplate: "- [ ] Tests added",
      },
    });
    expect(rules).toMatchObject({
      contributingPath: "CONTRIBUTING.md", pullRequestTemplatePath: ".github/pull_request_template.md", issueTemplates: true,
      requiresIssueFirst: true, cla: true, dco: false, requiresTests: true, requiresChangelog: true, dependencyBot: true, helpLabels: ["help wanted"],
    });
    expect(rules.rejectedChanges[0]).toMatch(/typos or whitespace/);
  });
});
