import type { DiscoveryQuery, DiscoveryResult } from "@gitgoblin/core";
import { MemoryCache, RateLimitError } from "@gitgoblin/sources";
import { describe, expect, it } from "vitest";
import { formatExplanation, formatResults, highlightReasons } from "../src/format.ts";
import { type Engine, type Runtime, run } from "../src/index.ts";
import { toQuery } from "../src/options.ts";

function sampleResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    repo: {
      host: "github.com",
      owner: "acme",
      name: "widget",
      url: "https://github.com/acme/widget",
      description: "Widgets for everyone, with a very long description that keeps going well past one hundred characters so it gets cut",
      topics: ["widgets"],
      language: "Rust",
      license: "MIT",
      stars: 1234,
      forks: 56,
      openIssues: 7,
      archived: false,
      fork: false,
    },
    goal: "contribute",
    score: 0.81,
    reasons: [
      { signal: "activity", weight: 0.12, detail: "last change yesterday" },
      { signal: "license", weight: -0.05, detail: "custom license" },
      { signal: "docs", weight: 0.08, detail: "README, homepage" },
      { signal: "popularity", weight: 0.01, detail: "1.2k stars" },
      { signal: "responsiveness", weight: -0.02, detail: "issues close in ~3 months" },
    ],
    signals: { activity: 0.95, docs: 0.8, license: 0.4 },
    evidence: { daysSincePush: 1 },
    issues: [{ number: 9, title: "Add dark mode", url: "https://github.com/acme/widget/issues/9", labels: ["good first issue"], createdAt: "2026-10-01T00:00:00Z" }],
    ...overrides,
  };
}

function fakeRuntime(engine: Partial<Engine> = {}, extra: { modules?: Record<string, Record<string, unknown>>; answers?: string[]; canPrompt?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(extra.answers ?? [])];
  const cache = new MemoryCache();
  const runtime: Runtime = {
    loadModule: async (name) => extra.modules?.[name],
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    canPrompt: extra.canPrompt ?? true,
    async createEngine() {
      return {
        engine: {
          discover: engine.discover ?? (async () => [sampleResult()]),
          explain: engine.explain ?? (async () => sampleResult()),
        },
        close() {},
        rateLimits: () => "search 29/30",
      };
    },
    openCache: () => cache,
    cachePath: () => "/tmp/gitgoblin-test/http-cache.sqlite",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    color: false,
    isInteractive: false,
    env: {},
  };
  return { runtime, out, err, cache, asked };
}

function fakeSiblings(status = "awaiting_approval") {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const modules = {
    "@gitgoblin/intel": {
      analyzeRepository: async (...args: unknown[]) => {
        calls.push({ fn: "analyzeRepository", args });
        return { profile: { languages: ["Rust"] }, opportunities: [{ issue: { number: 42, title: "Add --color flag" }, summary: "Add a flag" }] };
      },
      renderMarkdown: (report: { profile: { languages: string[] } }) => `# Report\n\nLanguages: ${report.profile.languages.join(", ")}`,
    },
    "@gitgoblin/engine": {
      runContribution: async (input: unknown, options: { approvePlan: (plan: string) => Promise<boolean> }) => {
        calls.push({ fn: "runContribution", args: [input] });
        const approved = await options.approvePlan("1. edit main.rs");
        return { runId: "run-1", runDir: "/nonexistent/run-1", status: approved ? status : "stopped", costUsd: 0.42, questions: [] };
      },
      publishRun: async (...args: unknown[]) => {
        calls.push({ fn: "publishRun", args });
        return { url: "https://github.com/acme/widget/pull/7" };
      },
    },
  };
  return { modules, calls };
}

describe("toQuery", () => {
  it("maps flags to a DiscoveryQuery and splits comma lists", () => {
    const query = toQuery("contribute", { language: ["rust,go", "zig"], topic: ["cli"], minStars: "10", like: "BurntSushi/ripgrep", limit: "5", seed: "7" });
    expect(query).toEqual({
      goal: "contribute",
      filters: expect.objectContaining({ languages: ["rust", "go", "zig"], topics: ["cli"], minStars: 10 }),
      seed: { host: "github.com", owner: "BurntSushi", name: "ripgrep" },
      limit: 5,
      randomSeed: 7,
    });
  });

  it("rejects bad numbers and bad seeds", () => {
    expect(() => toQuery("adopt", { limit: "0" })).toThrow(/--limit/);
    expect(() => toQuery("adopt", { minStars: "ten" })).toThrow(/--min-stars/);
    expect(() => toQuery("adopt", { like: "not a repo" })).toThrow(/--like/);
  });
});

describe("formatting", () => {
  it("highlights the strongest positive and negative reasons", () => {
    const picked = highlightReasons(sampleResult().reasons).map((r) => r.detail);
    expect(picked).toEqual(["last change yesterday", "README, homepage", "1.2k stars", "custom license"]);
  });

  it("renders a readable block per result", () => {
    const text = formatResults([sampleResult()], { color: false });
    expect(text).toContain(" 1. acme/widget  ★ 1.2k · Rust · MIT  score 0.81");
    expect(text).toContain("…");
    expect(text).toContain("+ last change yesterday");
    expect(text).toContain("− custom license");
    expect(text).toContain("issue #9 Add dark mode");
    expect(formatResults([], { color: false })).toMatch(/No repositories matched/);
  });

  it("renders every signal in an explanation, including unknown ones", () => {
    const text = formatExplanation(sampleResult(), { color: false });
    expect(text).toContain("activity              ██████████ 0.95 +0.12  last change yesterday");
    expect(text).toContain("busFactor               unknown ");
    expect(text).toContain("starter issues:");
  });
});

describe("run", () => {
  it("prints JSON for discover and forwards the parsed query", async () => {
    let received: DiscoveryQuery | undefined;
    const { runtime, out } = fakeRuntime({
      discover: async (query) => {
        received = query;
        return [sampleResult()];
      },
    });
    expect(await run(["discover", "adopt", "--language", "rust", "--limit", "3", "--json"], runtime)).toBe(0);
    expect(received).toMatchObject({ goal: "adopt", limit: 3, filters: { languages: ["rust"] } });
    const parsed = JSON.parse(out.join("\n")) as { query: DiscoveryQuery; results: DiscoveryResult[] };
    expect(parsed.results[0]?.repo.name).toBe("widget");
  });

  it("defaults to explore with a printed seed", async () => {
    let received: DiscoveryQuery | undefined;
    const { runtime, err } = fakeRuntime({
      discover: async (query) => {
        received = query;
        return [];
      },
    });
    expect(await run(["discover"], runtime)).toBe(0);
    expect(received?.goal).toBe("explore");
    expect(received?.randomSeed).toBeTypeOf("number");
    expect(err.join("\n")).toMatch(/pass --seed \d+/);
  });

  it("explains a repository and fails cleanly when it does not exist", async () => {
    const { runtime, out } = fakeRuntime();
    expect(await run(["explain", "acme/widget", "--goal", "adopt"], runtime)).toBe(0);
    expect(out.join("\n")).toContain("goal: contribute");

    const missing = fakeRuntime({ explain: async () => undefined });
    expect(await run(["explain", "nobody/nothing"], missing.runtime)).toBe(1);
    expect(missing.err.join("\n")).toMatch(/was not found/);
  });

  it("turns rate limits into advice and usage errors into exit code 2", async () => {
    const limited = fakeRuntime({
      discover: async () => {
        throw new RateLimitError("https://api.github.com/search/repositories", "", undefined);
      },
    });
    expect(await run(["discover", "learn"], limited.runtime)).toBe(1);
    expect(limited.err.join("\n")).toMatch(/gh auth login/);

    const { runtime, err } = fakeRuntime();
    expect(await run(["discover", "famous"], runtime)).toBe(2);
    expect(err.join("\n")).toMatch(/Unknown goal "famous"/);
    expect(await run(["explain", "???"], runtime)).toBe(2);
  });

  it("lists goals and reports on the cache", async () => {
    const { runtime, out, cache } = fakeRuntime();
    expect(await run(["goals"], runtime)).toBe(0);
    expect(out.join("\n")).toMatch(/revive\s+Valuable projects/);
    expect(out.join("\n")).toMatch(/weighs: usage, low activity/);

    cache.set("k", { status: 200, body: "{}", etag: null, fetchedAt: 0, ttlMs: 1 });
    out.length = 0;
    expect(await run(["cache"], runtime)).toBe(0);
    expect(out.join("\n")).toMatch(/1 entries/);
    expect(await run(["cache", "clear"], runtime)).toBe(0);
    expect(cache.stats().entries).toBe(0);
  });

  it("shows help with exit code 0", async () => {
    const { runtime, out } = fakeRuntime();
    expect(await run(["--help"], runtime)).toBe(0);
    expect(out.join("\n")).toContain("discover");
  });
});

describe("contribute", () => {
  it("publishes only after the person says yes twice, then confirms publishing", async () => {
    const siblings = fakeSiblings();
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y", "y"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42"], runtime)).toBe(0);
    expect(siblings.calls.map((c) => c.fn)).toEqual(["analyzeRepository", "runContribution", "publishRun"]);
    expect(siblings.calls[2]?.args).toEqual(["run-1", expect.objectContaining({ approved: true, draft: true })]);
    expect(asked).toHaveLength(3);
    expect(asked[2]).toMatch(/draft pull request/);
    expect(out.join("\n")).toContain("Draft pull request: https://github.com/acme/widget/pull/7");
  });

  it("never publishes when the final answer is no", async () => {
    const siblings = fakeSiblings();
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y", "n"] });
    expect(await run(["contribute", "acme/widget"], runtime)).toBe(0);
    expect(siblings.calls.map((c) => c.fn)).toEqual(["analyzeRepository", "runContribution"]);
    expect(out.join("\n")).toMatch(/Not published/);
  });

  it("stops before the engine when the first answer is no, or when the plan is rejected", async () => {
    const first = fakeSiblings();
    const a = fakeRuntime({}, { modules: first.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget"], a.runtime)).toBe(0);
    expect(first.calls.map((c) => c.fn)).toEqual(["analyzeRepository"]);

    const second = fakeSiblings();
    const b = fakeRuntime({}, { modules: second.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget"], b.runtime)).toBe(0);
    expect(second.calls.map((c) => c.fn)).toEqual(["analyzeRepository", "runContribution"]);
    expect(b.out.join("\n")).toMatch(/status: stopped/);
    expect(b.out.join("\n")).toMatch(/Nothing to publish/);
  });

  it("refuses to run without a terminal or without the sibling packages", async () => {
    const siblings = fakeSiblings();
    const noTty = fakeRuntime({}, { modules: siblings.modules, canPrompt: false });
    expect(await run(["contribute", "acme/widget"], noTty.runtime)).toBe(1);
    expect(noTty.err.join("\n")).toMatch(/interactive terminal/);

    const missing = fakeRuntime({}, { modules: {}, answers: ["y"] });
    expect(await run(["contribute", "acme/widget"], missing.runtime)).toBe(1);
    expect(missing.err.join("\n")).toMatch(/@gitgoblin\/intel and @gitgoblin\/engine/);
    expect(siblings.calls).toHaveLength(0);
  });

  it("runs analyze through intel: Markdown by default, JSON on --json, options passed through", async () => {
    const siblings = fakeSiblings();
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget", "--max", "3", "--no-links"], runtime)).toBe(0);
    const [, options] = siblings.calls[0]?.args as [unknown, { hints?: { goal: string }; maxOpportunities: number; checkLinks: boolean; dependencyChecks: boolean }];
    expect(options).toMatchObject({ maxOpportunities: 3, checkLinks: false, dependencyChecks: true });
    expect(options.hints?.goal).toBe("contribute");
    expect(out.join("\n")).toBe("# Report\n\nLanguages: Rust");

    const asJson = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget", "--json"], asJson.runtime)).toBe(0);
    expect(JSON.parse(asJson.out.join("\n"))).toMatchObject({ profile: { languages: ["Rust"] } });
  });
});
