import { describe, expect, it } from "vitest";
import { buildSearchPlans, prefilter } from "../src/index.ts";
import { facts, NOW } from "./fixtures.ts";

const context = { now: NOW, random: () => 0.5 };

describe("buildSearchPlans", () => {
  it("builds goal-specific plans and multiplies them by language", () => {
    const plans = buildSearchPlans({ goal: "contribute", filters: { languages: ["Rust", "Go"], topics: ["cli"] } }, context);
    expect(plans).toHaveLength(6);
    const first = plans[0];
    expect(first?.q).toContain("good-first-issues:>0");
    expect(first?.q).toContain("language:Rust");
    expect(first?.q).toContain("topic:cli");
    expect(first?.q).toContain("archived:false");
    expect(first?.q).toContain("fork:false");
    expect(first?.q).toMatch(/pushed:>2026-07-\d\d/);
    expect(first?.sort).toBe("help-wanted-issues");
    expect(plans.some((p) => p.q.includes("language:Go"))).toBe(true);
  });

  it("searches archived repositories too for revive, where forking an archived project is the point", () => {
    expect(buildSearchPlans({ goal: "revive" }, context).every((p) => !p.q.includes("archived:"))).toBe(true);
    expect(buildSearchPlans({ goal: "adopt" }, context).every((p) => p.q.includes("archived:false"))).toBe(true);
  });

  it("lets user star bounds override the goal's defaults", () => {
    const [plan] = buildSearchPlans({ goal: "learn", filters: { minStars: 50, maxStars: 500 } }, context);
    expect(plan?.q).toContain("stars:50..500");
    expect(plan?.q).not.toContain("stars:>=500");
  });

  it("quotes multi-word keywords and strips quote characters", () => {
    const [plan] = buildSearchPlans({ goal: "adopt", filters: { keywords: ['markdown "parser"', "cli"] } }, context);
    expect(plan?.q).toContain('"markdown parser"');
    expect(plan?.q).toContain(" cli ");
  });

  it("picks a random page for the explore goal so results change between runs", () => {
    const low = buildSearchPlans({ goal: "explore" }, { now: NOW, random: () => 0 });
    const high = buildSearchPlans({ goal: "explore" }, { now: NOW, random: () => 0.99 });
    expect(low[0]?.page).toBe(1);
    expect(high[0]?.page).toBe(4);
    expect(low[0]?.q).toContain("stars:5..60");
  });

  it("searches for dormant repositories when reviving", () => {
    const plans = buildSearchPlans({ goal: "revive" }, context);
    expect(plans[0]?.q).toMatch(/pushed:<2025-10-\d\d/);
    expect(plans[0]?.q).toContain("stars:50..5000");
    expect(plans).toHaveLength(3);
  });

  it("uses the seed's topics and language for more-like-this", () => {
    const seed = facts({ owner: "BurntSushi", name: "ripgrep", language: "Rust", topics: ["grep", "search", "regex", "cli", "rust"], stars: 69_000 });
    const plans = buildSearchPlans({ goal: "adopt", seed }, { ...context, seedFacts: seed });
    expect(plans[0]?.q).toContain("topic:grep topic:search topic:regex language:Rust");
    expect(plans[0]?.q).toMatch(/stars:3450\.\.1380000/);
    expect(plans.length).toBe(4);
  });

  it("falls back to package keywords, then description words, when a seed has no topics", () => {
    const seed = facts({ owner: "o", name: "n", language: "Go", topics: [], description: "Fast incremental parser generator" });
    const [byKeyword] = buildSearchPlans({ goal: "learn", seed }, { ...context, seedFacts: seed, seedKeywords: ["Parser", "incremental", "ast", "x"] });
    expect(byKeyword?.q).toContain("parser incremental ast language:Go");
    const [byWords] = buildSearchPlans({ goal: "learn", seed }, { ...context, seedFacts: seed });
    expect(byWords?.q).toContain("incremental parser generator");
    expect(byWords?.q).toContain("language:Go");
  });
});

describe("prefilter", () => {
  it("drops archived repositories except for revive, and honours user filters", () => {
    const archived = facts({ owner: "a", name: "b", archived: true });
    expect(prefilter(archived, { goal: "adopt" }, NOW)).toBe("archived");
    expect(prefilter(archived, { goal: "revive" }, NOW)).toBeUndefined();
    expect(prefilter(archived, { goal: "adopt", filters: { includeArchived: true } }, NOW)).toBeUndefined();

    const repo = facts({ owner: "Acme", name: "x", stars: 10, language: "Rust", license: "MIT" });
    expect(prefilter(repo, { goal: "adopt", filters: { minStars: 50 } }, NOW)).toBe("too few stars");
    expect(prefilter(repo, { goal: "adopt", filters: { excludeOwners: ["acme"] } }, NOW)).toBe("excluded owner");
    expect(prefilter(repo, { goal: "adopt", filters: { languages: ["go"] } }, NOW)).toBe("other language");
    expect(prefilter(repo, { goal: "adopt", filters: { licenses: ["Apache-2.0"] } }, NOW)).toBe("other license");
    expect(prefilter(repo, { goal: "adopt", filters: { languages: ["rust"], licenses: ["mit"] } }, NOW)).toBeUndefined();
  });
});
