import type { RepoFacts, RepoRef } from "@gitgoblin/core";
import { repoId } from "@gitgoblin/core";
import type { GitHubRepoDetails, SearchOptions, SearchResult } from "@gitgoblin/sources";
import { describe, expect, it } from "vitest";
import { DiscoveryEngine, type EcosystemsSource, type GitHubSource, type ProgressEvent } from "../src/index.ts";
import { daysAgo, details, ecosystems, facts, issueStats, NOW, pkg } from "./fixtures.ts";

class FakeGitHub implements GitHubSource {
  readonly searches: string[] = [];
  readonly repos: RepoFacts[];
  readonly authenticated: boolean;
  readonly detailsFor: Map<string, GitHubRepoDetails>;
  constructor(repos: RepoFacts[], authenticated = true, detailsFor: Map<string, GitHubRepoDetails> = new Map()) {
    this.repos = repos;
    this.authenticated = authenticated;
    this.detailsFor = detailsFor;
  }
  async searchRepositories(q: string, _options?: SearchOptions): Promise<SearchResult> {
    this.searches.push(q);
    // Every plan returns everything; the engine must dedupe.
    return { total: this.repos.length, items: this.repos };
  }
  async getRepository(ref: RepoRef): Promise<RepoFacts | undefined> {
    return this.repos.find((r) => repoId(r) === repoId(ref));
  }
  async repoDetails(refs: RepoRef[]): Promise<Map<string, GitHubRepoDetails>> {
    const out = new Map<string, GitHubRepoDetails>();
    for (const ref of refs) {
      const d = this.detailsFor.get(repoId(ref));
      if (d) out.set(repoId(ref), d);
    }
    return out;
  }
}

class FakeEcosystems implements EcosystemsSource {
  readonly failFor: string[];
  constructor(failFor: string[] = []) {
    this.failFor = failFor;
  }
  async lookupRepository(ref: RepoRef) {
    if (this.failFor.includes(ref.name)) throw new Error("ecosyste.ms is down");
    return ecosystems({ fullName: `${ref.owner}/${ref.name}` });
  }
  async lookupPackages(ref: RepoRef) {
    return ref.name.includes("lib") ? [pkg({ name: ref.name })] : [];
  }
  async lookupIssueStats() {
    return issueStats();
  }
}

const catalogue: RepoFacts[] = [
  facts({ owner: "acme", name: "lib-one", stars: 900, homepage: "https://acme.dev" }),
  facts({ owner: "acme", name: "lib-two", stars: 800 }),
  facts({ owner: "acme", name: "lib-three", stars: 700 }),
  facts({ owner: "solo", name: "tool", stars: 60 }),
  facts({ owner: "old", name: "lib-dusty", stars: 3000, pushedAt: daysAgo(900) }),
  facts({ owner: "shelf", name: "archived-lib", stars: 5000, archived: true }),
  facts({ owner: "copy", name: "forked-lib", stars: 10, fork: true }),
];

function makeEngine(github = new FakeGitHub(catalogue), ecosystemsSource: EcosystemsSource = new FakeEcosystems()) {
  const events: ProgressEvent[] = [];
  const engine = new DiscoveryEngine({ github, ecosystems: ecosystemsSource, now: () => NOW, onProgress: (e) => events.push(e) });
  return { engine, events, github };
}

describe("DiscoveryEngine.discover", () => {
  it("dedupes, filters, enriches, ranks and spreads results across owners", async () => {
    const github = new FakeGitHub(catalogue, true, new Map([[repoId(catalogue[0]!), details()]]));
    const { engine, events } = makeEngine(github);
    const results = await engine.discover({ goal: "contribute", filters: { languages: ["rust"] }, limit: 4 });

    expect(github.searches.length).toBe(3);
    expect(results).toHaveLength(4);
    const names = results.map((r) => `${r.repo.owner}/${r.repo.name}`);
    expect(new Set(names).size).toBe(4);
    expect(names).not.toContain("old/lib-dusty");
    expect(names).not.toContain("shelf/archived-lib");
    expect(names).not.toContain("copy/forked-lib");
    expect(names.slice(0, 3).filter((n) => n.startsWith("acme/")).length).toBeLessThanOrEqual(2);
    expect(results[0]?.repo.name).toBe("lib-one");
    expect(results[0]?.issues?.[0]?.title).toBe("Add --color flag");
    expect(results[1]?.issues).toBeUndefined();
    // Diversification pushes acme's third repository below a lower-scored stranger.
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    expect(names[2]).toBe("solo/tool");
    expect(names[3]).toMatch(/^acme\/lib-/);
    for (const r of results) {
      expect(r.goal).toBe("contribute");
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.evidence.contributors).toBe(60);
    }
    expect(events.some((e) => e.stage === "enrich")).toBe(true);
  });

  it("keeps going when an enrichment source fails for one repository", async () => {
    const { engine, events } = makeEngine(new FakeGitHub(catalogue, false), new FakeEcosystems(["lib-two"]));
    const results = await engine.discover({ goal: "adopt", limit: 10 });
    const broken = results.find((r) => r.repo.name === "lib-two");
    expect(broken).toBeDefined();
    expect(broken?.evidence.contributors).toBeUndefined();
    expect(events.some((e) => e.stage === "warning" && e.message.includes("ecosyste.ms is down"))).toBe(true);
    expect(results.every((r) => r.issues === undefined)).toBe(true);
  });

  it("surfaces dormant projects for revive and excludes active ones", async () => {
    const { engine } = makeEngine();
    const results = await engine.discover({ goal: "revive" });
    expect(results.map((r) => r.repo.name)).toEqual(["lib-dusty", "archived-lib"]);
    expect(results[1]?.reasons.some((r) => r.detail.includes("archived"))).toBe(true);
  });

  it("is reproducible for explore when given a random seed", async () => {
    const { engine } = makeEngine();
    const a = await engine.discover({ goal: "explore", randomSeed: 7 });
    const b = await engine.discover({ goal: "explore", randomSeed: 7 });
    expect(a.map((r) => [r.repo.name, r.score])).toEqual(b.map((r) => [r.repo.name, r.score]));
  });

  it("excludes the seed itself from more-like-this results", async () => {
    const { engine } = makeEngine();
    const results = await engine.discover({ goal: "adopt", seed: { host: "github.com", owner: "acme", name: "lib-one" } });
    expect(results.map((r) => r.repo.name)).not.toContain("lib-one");
  });

  it("rejects unknown goals and missing seeds", async () => {
    const { engine } = makeEngine();
    await expect(engine.discover({ goal: "popular" as never })).rejects.toThrow(/Unknown goal/);
    await expect(engine.discover({ goal: "adopt", seed: { host: "github.com", owner: "no", name: "such" } })).rejects.toThrow(/not found/);
  });

  it("fails loudly only when every search fails", async () => {
    const failing = new FakeGitHub(catalogue);
    failing.searchRepositories = async () => {
      throw new Error("rate limited");
    };
    const { engine } = makeEngine(failing);
    await expect(engine.discover({ goal: "adopt" })).rejects.toThrow("rate limited");
  });
});

describe("DiscoveryEngine.explain", () => {
  it("returns full signals for a known repository and undefined otherwise", async () => {
    const { engine } = makeEngine();
    const result = await engine.explain({ host: "github.com", owner: "acme", name: "lib-one" }, "adopt");
    expect(result?.score).toBeGreaterThan(0.5);
    expect(result?.signals.usage).toBeGreaterThan(0);
    expect(await engine.explain({ host: "github.com", owner: "none", name: "none" }, "adopt")).toBeUndefined();
  });
});
