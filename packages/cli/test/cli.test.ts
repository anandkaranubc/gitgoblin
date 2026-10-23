import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryQuery, DiscoveryResult } from "@gitgoblin/core";
import type { ChangePlan, RunOptions, RunResult, RunStatus } from "@gitgoblin/engine";
import type { AnalysisOptions, AnalysisReport, RepoRefInput } from "@gitgoblin/intel";
import { MemoryCache, RateLimitError } from "@gitgoblin/sources";
import { describe, expect, it } from "vitest";
import { formatExplanation, formatResults, highlightReasons } from "../src/format.ts";
import { type Engine, type Runtime, run } from "../src/index.ts";
import { toQuery } from "../src/options.ts";
import { sampleOpportunity, sampleReport, writeInstall, writeRun } from "./fixtures.ts";

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

function fakeRuntime(engine: Partial<Engine> = {}, extra: { modules?: Record<string, Record<string, unknown>>; answers?: string[]; canPrompt?: boolean; isInteractive?: boolean } = {}) {
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
    isInteractive: extra.isInteractive ?? false,
    env: {},
  };
  return { runtime, out, err, cache, asked };
}

const PLAN: ChangePlan = {
  goal: "Thread --color through to the renderer",
  steps: ["Pass the flag from main to render()", "Add a regression test"],
  filesToModify: ["src/main.rs"],
  filesToCreate: [],
  testsToAdd: ["color flag disables escapes"],
  outOfScope: [],
  risks: [],
  needsNewDependency: false,
};

/**
 * Stand-ins for @gitgoblin/intel and @gitgoblin/engine that behave like the real ones at the
 * boundary: intel returns a schema-shaped report; the engine reports progress through the Reporter
 * object, asks for plan approval, and leaves a run directory with the files a person reads.
 */
function fakeSiblings(options: { status?: RunStatus; report?: AnalysisReport; install?: { exitCode: number | null; output: string } } = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const report = options.report ?? sampleReport();
  const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-cli-"));
  const modules = {
    "@gitgoblin/intel": {
      analyzeRepository: async (ref: RepoRefInput, analysisOptions: AnalysisOptions) => {
        calls.push({ fn: "analyzeRepository", args: [ref, analysisOptions] });
        return report;
      },
      renderMarkdown: (r: AnalysisReport) => `# ${r.profile.repo.owner}/${r.profile.repo.name}\n\n## Opportunities (${r.opportunities.length})`,
      AnalysisReport: {
        parse: (value: unknown) => {
          // Shaped like a zod error: a message that starts with the JSON issue list, and an `issues` array.
          if (!value || typeof value !== "object" || (value as { version?: string }).version !== "1") {
            const issues = [{ path: ["version"], message: 'Invalid input: expected "1"' }];
            throw Object.assign(new Error(JSON.stringify(issues, null, 2)), { issues });
          }
          return value as AnalysisReport;
        },
      },
    },
    "@gitgoblin/engine": {
      DEFAULT_LIMITS: { maxCostUsd: 10 },
      runContribution: async (input: unknown, runOptions: RunOptions): Promise<RunResult> => {
        calls.push({ fn: "runContribution", args: [input, runOptions] });
        const reporter = runOptions.reporter!;
        reporter.phase("run", "20261022-abcd for Fix #42");
        reporter.info("orient Read src/main.rs");
        reporter.warn("baseline lint: fail");
        // Engines that report the install and the baseline pass them as a second argument; older ones do not.
        const approve = runOptions.approvePlan as unknown as (plan: ChangePlan, context?: unknown) => Promise<boolean>;
        const approved = await approve(PLAN, { baseline: [] });
        const runId = "20261022-abcd";
        const runDir = join(runOptions.workdir!, "runs", runId);
        mkdirSync(runDir, { recursive: true });
        const status = approved ? (options.status ?? "awaiting_approval") : "stopped";
        writeFileSync(join(runDir, "report.md"), `# gitgoblin run ${runId}\n\n- Status: **${status}**\n\n## Verification\n- test: pass (cargo test, 12s)\n\n## Review: approve\n`);
        if (options.install) writeInstall(runDir, options.install);
        if (status === "awaiting_approval") {
          writeFileSync(join(runDir, "pr-title.txt"), "fix: honour --color on Windows\n");
          writeFileSync(join(runDir, "pr.md"), "## Summary\n\nFixes #42\n");
          writeFileSync(join(runDir, "diff.patch"), "diff --git a/src/main.rs b/src/main.rs\n");
        }
        return { runId, runDir, status, reason: approved ? "ready for human review" : "plan rejected by the operator", questions: [], workspace: join(runDir, "workspace"), branch: "gitgoblin/fix-42", costUsd: 0.42, durationMs: 61_000 };
      },
      publishRun: async (...args: unknown[]) => {
        calls.push({ fn: "publishRun", args });
        return { url: "https://github.com/acme/widget/pull/7", head: "me:gitgoblin/fix-42", pushedTo: "https://github.com/me/widget.git", commands: [] };
      },
    },
  };
  return { modules, calls, workdir };
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

  it("points an interactive discover at the next command", async () => {
    const { runtime, err } = fakeRuntime({}, { isInteractive: true });
    expect(await run(["discover", "contribute"], runtime)).toBe(0);
    expect(err.join("\n")).toContain("gitgoblin analyze acme/widget");
    const quiet = fakeRuntime({}, { isInteractive: false });
    expect(await run(["discover", "contribute"], quiet.runtime)).toBe(0);
    expect(quiet.err.join("\n")).not.toContain("gitgoblin analyze");
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

describe("analyze", () => {
  it("runs through intel: Markdown by default, JSON on --json, options passed through", async () => {
    const siblings = fakeSiblings();
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget", "--max", "3", "--no-links"], runtime)).toBe(0);
    const [, options] = siblings.calls[0]?.args as [unknown, AnalysisOptions];
    expect(options).toMatchObject({ maxOpportunities: 3, checkLinks: false, dependencyChecks: true });
    expect(options.hints?.goal).toBe("contribute");
    expect(out.join("\n")).toContain("# acme/widget\n\n## Opportunities (3)");

    const asJson = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget", "--json"], asJson.runtime)).toBe(0);
    expect(JSON.parse(asJson.out.join("\n"))).toMatchObject({ version: "1", profile: { repo: { name: "widget" } } });
  });

  it("analyzes an existing checkout with --local", async () => {
    const siblings = fakeSiblings();
    const { runtime } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget", "--local", "/work/widget"], runtime)).toBe(0);
    expect(siblings.calls[0]?.args[0]).toEqual({ host: "github.com", owner: "acme", name: "widget", localPath: "/work/widget" });
  });

  it("ends by saying how to continue, with the best opportunity's id, or the saved report", async () => {
    const siblings = fakeSiblings();
    const text = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget"], text.runtime)).toBe(0);
    expect(text.err.join("\n")).toContain("gitgoblin contribute acme/widget --opportunity opp-aaaa1111");

    const file = join(siblings.workdir, "report.json");
    const saved = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget", "--json", "--out", file], saved.runtime)).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: "1" });
    expect(saved.err.join("\n")).toContain(`gitgoblin contribute acme/widget --report ${file}`);

    const empty = fakeRuntime({}, { modules: fakeSiblings({ report: sampleReport([]) }).modules });
    expect(await run(["analyze", "acme/widget"], empty.runtime)).toBe(0);
    expect(empty.err.join("\n")).not.toContain("gitgoblin contribute");
  });
});

describe("contribute", () => {
  it("publishes only after the person says yes twice, then confirms publishing", async () => {
    const siblings = fakeSiblings();
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y", "y"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(siblings.calls.map((c) => c.fn)).toEqual(["analyzeRepository", "runContribution", "publishRun"]);
    expect(siblings.calls[2]?.args).toEqual(["20261022-abcd", expect.objectContaining({ approved: true, draft: true, workdir: siblings.workdir })]);
    expect(asked).toHaveLength(3);
    expect(asked[2]).toMatch(/draft pull request/);
    expect(out.join("\n")).toContain("Draft pull request: https://github.com/acme/widget/pull/7");
  });

  it("hands the engine a real Reporter and relays its progress", async () => {
    const siblings = fakeSiblings();
    const { runtime, err, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    const [input, options] = siblings.calls[1]?.args as [{ profile: unknown; opportunity: { id: string } }, RunOptions];
    expect(input.opportunity.id).toBe("opp-aaaa1111");
    // No --max-cost given: the cap is the engine's own default, not a number the CLI invents.
    expect(options.limits).toEqual({ maxCostUsd: 10 });
    expect(asked[0]).toContain("spending up to $10.00");
    expect(err.join("\n")).toContain("==> run: 20261022-abcd for Fix #42");
    expect(err.join("\n")).toContain("    orient Read src/main.rs");
    expect(err.join("\n")).toContain(" !! baseline lint: fail");
  });

  it("honours an explicit --max-cost and shows it in the question", async () => {
    const siblings = fakeSiblings();
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--max-cost", "3.5", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(asked[0]).toContain("spending up to $3.50");
    expect((siblings.calls[1]?.args[1] as RunOptions).limits).toEqual({ maxCostUsd: 3.5 });
  });

  it("shows the install failure and red baseline checks at the plan question when the engine reports them", async () => {
    const siblings = fakeSiblings();
    const engine = siblings.modules["@gitgoblin/engine"] as { runContribution: (input: unknown, options: RunOptions) => Promise<RunResult> };
    const original = engine.runContribution;
    engine.runContribution = async (input, options) => {
      const approve = options.approvePlan!;
      options.approvePlan = (plan) => (approve as (p: ChangePlan, c?: unknown) => Promise<boolean>)(plan, { install: { exitCode: 1, logPath: join(siblings.workdir, "install-output.txt") }, baseline: [{ name: "test", status: "fail" }] });
      return original(input, options);
    };
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(asked[1]).toContain("Plan: Thread --color through to the renderer");
    expect(asked[1]).toContain("the repository's install failed (exit 1)");
    expect(asked[1]).toContain("Failing before any change: test.");
    expect(asked[1]).toMatch(/Implement this plan\? \[y\/N\] $/);
  });

  it("shows the plan in plain words before asking to implement it", async () => {
    const siblings = fakeSiblings();
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(asked[1]).toContain("Plan: Thread --color through to the renderer");
    expect(asked[1]).toContain("  1. Pass the flag from main to render()");
    expect(asked[1]).toContain("Files: src/main.rs");
    expect(asked[1]).not.toContain("{");
  });

  it("lists the opportunities with their evidence and lets the person pick by number or id", async () => {
    const siblings = fakeSiblings();
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["opp-cccc3333", "n"] });
    expect(await run(["contribute", "acme/widget", "--workdir", siblings.workdir], runtime)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("1. Fix #42: --color flag is ignored on Windows");
    expect(printed).toContain("https://github.com/acme/widget/issues/42");
    expect(printed).toContain("someone is already working on #57");
    expect(asked[0]).toMatch(/\[1-3, or an id; Enter for 1\]/);
    expect(printed).toContain("Opportunity: Triage #61: unclear feature request");

    const byFlag = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--opportunity", "2", "--workdir", siblings.workdir], byFlag.runtime)).toBe(0);
    expect(byFlag.out.join("\n")).toContain("Opportunity: Fix #57: panic on empty config");
    expect(byFlag.out.join("\n")).toContain("The engine will refuse this one at intake: someone is already working on #57");
    expect(byFlag.asked[0]).toMatch(/^Run it anyway against acme\/widget/);
  });

  it("asks again when the answer matches nothing, and gives up after three tries", async () => {
    const siblings = fakeSiblings();
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["9", "opp-nope", "3", "n"] });
    expect(await run(["contribute", "acme/widget", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(asked.filter((q) => q.startsWith("Which opportunity?"))).toHaveLength(3);
    expect(out.join("\n")).toContain("There is no opportunity 9");
    expect(out.join("\n")).toContain("Opportunity: Triage #61: unclear feature request");

    const hopeless = fakeRuntime({}, { modules: siblings.modules, answers: ["x", "y", "z"] });
    expect(await run(["contribute", "acme/widget", "--workdir", siblings.workdir], hopeless.runtime)).toBe(1);
    expect(hopeless.err.join("\n")).toMatch(/No opportunity "z"/);
  });

  it("refuses --issue together with --opportunity instead of silently preferring one", async () => {
    const siblings = fakeSiblings();
    const { runtime, err } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--opportunity", "2", "--workdir", siblings.workdir], runtime)).toBe(1);
    expect(err.join("\n")).toMatch(/either --issue or --opportunity/);
    expect(siblings.calls).toHaveLength(0);
  });

  it("streams analysis progress in a terminal, since the analysis takes a while", async () => {
    const siblings = fakeSiblings();
    const { runtime } = fakeRuntime({}, { modules: siblings.modules, answers: ["n"], isInteractive: true });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    const [, options] = siblings.calls[0]?.args as [unknown, AnalysisOptions];
    expect(options.log).toBeTypeOf("function");
    const quiet = fakeRuntime({}, { modules: siblings.modules, answers: ["n"], isInteractive: false });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], quiet.runtime)).toBe(0);
    expect((siblings.calls[1]?.args[1] as AnalysisOptions).log).toBeUndefined();
  });

  it("says that a report from --local leads to a worktree of that checkout, not a clone", async () => {
    const siblings = fakeSiblings();
    const report = sampleReport();
    report.profile.repo = { host: "github.com", owner: "acme", name: "widget", localPath: "/work/widget" };
    const file = join(siblings.workdir, "local-report.json");
    writeFileSync(file, JSON.stringify(report));
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--report", file, "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(asked[0]).toContain("in a git worktree of /work/widget");
    expect(asked[0]).not.toContain("local clone");
  });

  it("reuses a saved report instead of analyzing again, and refuses one for another repository", async () => {
    const siblings = fakeSiblings();
    const file = join(siblings.workdir, "report.json");
    writeFileSync(file, JSON.stringify(sampleReport()));
    const { runtime } = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--report", file, "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(siblings.calls.map((c) => c.fn)).toEqual([]);

    const other = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/other", "--report", file, "--workdir", siblings.workdir], other.runtime)).toBe(1);
    expect(other.err.join("\n")).toMatch(/report .* is for acme\/widget, not acme\/other/);

    writeFileSync(file, JSON.stringify({ hello: "world" }));
    const broken = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--report", file, "--workdir", siblings.workdir], broken.runtime)).toBe(1);
    expect(broken.err.join("\n")).toMatch(/not an analysis report.*version: Invalid input: expected "1"/);
    expect(broken.err.join("\n")).not.toContain("[");
  });

  it("shows what the engine did and where the diff is before asking to publish", async () => {
    const siblings = fakeSiblings();
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("## Verification\n- test: pass (cargo test, 12s)");
    expect(printed).toContain("## Review: approve");
    expect(printed).toContain("fix: honour --color on Windows");
    expect(printed).toContain("Fixes #42");
    expect(printed).toContain(`Diff: ${join(siblings.workdir, "runs", "20261022-abcd", "diff.patch")}`);
    expect(printed).toMatch(/\$0\.42/);
    expect(asked[2]).toMatch(/draft pull request/);
    expect(printed).toContain(`gitgoblin publish 20261022-abcd`);
  });

  it("never publishes when the final answer is no", async () => {
    const siblings = fakeSiblings();
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(siblings.calls.map((c) => c.fn)).toEqual(["analyzeRepository", "runContribution"]);
    expect(out.join("\n")).toMatch(/Not published/);
  });

  it("stops before the engine when the first answer is no, or when the plan is rejected", async () => {
    const first = fakeSiblings();
    const a = fakeRuntime({}, { modules: first.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", first.workdir], a.runtime)).toBe(0);
    expect(first.calls.map((c) => c.fn)).toEqual(["analyzeRepository"]);

    const second = fakeSiblings();
    const b = fakeRuntime({}, { modules: second.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", second.workdir], b.runtime)).toBe(0);
    expect(second.calls.map((c) => c.fn)).toEqual(["analyzeRepository", "runContribution"]);
    expect(b.out.join("\n")).toMatch(/stopped: plan rejected by the operator/);
    expect(b.out.join("\n")).toMatch(/Nothing to publish/);
  });

  it("exits non-zero when the run failed, and prints the questions when it escalated", async () => {
    const failed = fakeSiblings({ status: "failed" });
    const a = fakeRuntime({}, { modules: failed.modules, answers: ["y", "y"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", failed.workdir], a.runtime)).toBe(1);
    expect(a.err.join("\n")).toMatch(/error: .*failed/);

    const escalated = fakeSiblings({ status: "escalated" });
    const b = fakeRuntime({}, { modules: escalated.modules, answers: ["y", "y"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", escalated.workdir], b.runtime)).toBe(0);
    expect(b.out.join("\n")).toMatch(/escalated/);
    expect(existsSync(join(escalated.workdir, "runs", "20261022-abcd", "report.md"))).toBe(true);
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

  it("stops with advice when the only opportunity is one the engine will refuse", async () => {
    const siblings = fakeSiblings({ report: sampleReport([sampleOpportunity({ kind: "triage", files: [] })]) });
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(out.join("\n")).toContain("The engine will refuse this one at intake: needs a reply on the issue, not a patch");
    expect(asked[0]).toMatch(/^Run it anyway against acme\/widget/);
  });
});

describe("runs, show and publish", () => {
  it("lists the runs under the workdir, newest first", async () => {
    const siblings = fakeSiblings();
    writeRun(siblings.workdir, "20261021-120000-aaaa", { status: "stopped", reason: "plan rejected by the operator" });
    writeRun(siblings.workdir, "20261022-093000-bbbb");
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["runs", "--workdir", siblings.workdir], runtime)).toBe(0);
    const lines = out.join("\n").split("\n");
    expect(lines.findIndex((l) => l.includes("20261022-093000-bbbb"))).toBeLessThan(lines.findIndex((l) => l.includes("20261021-120000-aaaa")));
    expect(out.join("\n")).toContain("awaiting_approval");
    expect(out.join("\n")).toContain("gitgoblin publish 20261022-093000-bbbb");

    const empty = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["runs", "--workdir", join(siblings.workdir, "elsewhere")], empty.runtime)).toBe(0);
    expect(empty.out.join("\n")).toMatch(/No runs yet/);
  });

  it("shows a run's report, or its diff or pull request text on request", async () => {
    const siblings = fakeSiblings();
    writeRun(siblings.workdir, "20261022-093000-bbbb");
    const report = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "20261022-093000-bbbb", "--workdir", siblings.workdir], report.runtime)).toBe(0);
    expect(report.out.join("\n")).toContain("# gitgoblin run 20261022-093000-bbbb");

    const diff = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "20261022-093000-bbbb", "--diff", "--workdir", siblings.workdir], diff.runtime)).toBe(0);
    expect(diff.out.join("\n")).toContain("diff --git a/src/main.rs");

    const pr = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "20261022-093000-bbbb", "--pr", "--workdir", siblings.workdir], pr.runtime)).toBe(0);
    expect(pr.out.join("\n")).toContain("fix: honour --color on Windows");
    expect(pr.out.join("\n")).toContain("Fixes #42");

    const missing = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "nope", "--workdir", siblings.workdir], missing.runtime)).toBe(1);
    expect(missing.err.join("\n")).toMatch(/no run "nope".*gitgoblin runs/s);
  });

  it("publishes a prepared run only after showing it and hearing yes", async () => {
    const siblings = fakeSiblings();
    writeRun(siblings.workdir, "20261022-093000-bbbb");
    const { runtime, out, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y"] });
    expect(await run(["publish", "20261022-093000-bbbb", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(out.join("\n")).toContain("fix: honour --color on Windows");
    expect(out.join("\n")).toContain(join(siblings.workdir, "runs", "20261022-093000-bbbb", "diff.patch"));
    expect(asked[0]).toMatch(/draft pull request/);
    expect(siblings.calls.map((c) => c.fn)).toEqual(["publishRun"]);
    expect(siblings.calls[0]?.args).toEqual(["20261022-093000-bbbb", expect.objectContaining({ approved: true, draft: true, workdir: siblings.workdir })]);
    expect(out.join("\n")).toContain("Draft pull request: https://github.com/acme/widget/pull/7");

    const ready = fakeRuntime({}, { modules: siblings.modules, answers: ["y"] });
    expect(await run(["publish", "20261022-093000-bbbb", "--ready", "--workdir", siblings.workdir], ready.runtime)).toBe(0);
    expect(siblings.calls[1]?.args).toEqual(["20261022-093000-bbbb", expect.objectContaining({ draft: false })]);
    expect(ready.asked[0]).toMatch(/ready-for-review pull request/);
  });

  it("does not publish on no, without a terminal, or when the run has nothing prepared", async () => {
    const siblings = fakeSiblings();
    writeRun(siblings.workdir, "20261022-093000-bbbb");
    writeRun(siblings.workdir, "20261021-120000-aaaa", { status: "stopped", reason: "plan rejected by the operator" });
    const no = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["publish", "20261022-093000-bbbb", "--workdir", siblings.workdir], no.runtime)).toBe(0);
    expect(no.out.join("\n")).toMatch(/Not published/);

    const noTty = fakeRuntime({}, { modules: siblings.modules, canPrompt: false });
    expect(await run(["publish", "20261022-093000-bbbb", "--workdir", siblings.workdir], noTty.runtime)).toBe(1);
    expect(noTty.err.join("\n")).toMatch(/interactive terminal/);

    const stopped = fakeRuntime({}, { modules: siblings.modules, answers: ["y"] });
    expect(await run(["publish", "20261021-120000-aaaa", "--workdir", siblings.workdir], stopped.runtime)).toBe(1);
    expect(stopped.err.join("\n")).toMatch(/is stopped \(plan rejected by the operator\), so there is nothing to publish/);
    expect(siblings.calls).toHaveLength(0);
  });
});

describe("control characters never reach the terminal", () => {
  it("are stripped from the chosen opportunity's title and from the pull request text a run produced", async () => {
    const siblings = fakeSiblings({ report: sampleReport([sampleOpportunity({ title: "Fix #42: \u001b[31mred\u001b[0m" })]) });
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(out.join("\n")).toContain("Opportunity: Fix #42: red");
    expect(out.join("\n")).not.toContain("\u001b");

    writeRun(siblings.workdir, "20261022-093000-bbbb");
    writeFileSync(join(siblings.workdir, "runs", "20261022-093000-bbbb", "pr-title.txt"), "fix: \u001b]8;;https://evil.example\u0007honour --color\u001b]8;;\u0007\n");
    const pr = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "20261022-093000-bbbb", "--pr", "--workdir", siblings.workdir], pr.runtime)).toBe(0);
    expect(pr.out.join("\n")).toContain("fix: honour --color");
    expect(pr.out.join("\n")).not.toContain("\u001b");
  });
});

describe("a failed install is explained where the person is looking", () => {
  const LOG = "resolving packages\nError: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK\n  Operation not permitted (os error 1)\n";

  it("contribute prints the end of the install log after the run's status", async () => {
    const siblings = fakeSiblings({ status: "escalated", install: { exitCode: 1, output: LOG } });
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("The repository's install failed (exit 1). End of ");
    expect(printed).toContain("  Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK");
    expect(printed.indexOf("install failed (exit 1)")).toBeLessThan(printed.indexOf("# gitgoblin run"));
  });

  it("contribute says nothing about an install that worked", async () => {
    const siblings = fakeSiblings({ status: "escalated", install: { exitCode: 0, output: "Done in 3s" } });
    const { runtime, out } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "y"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(out.join("\n")).not.toContain("install failed");
  });

  it("show --install prints the whole install log, or says there was none", async () => {
    const siblings = fakeSiblings();
    writeRun(siblings.workdir, "20261023-163018-bnlx", { status: "escalated", install: { exitCode: 1, output: LOG } });
    writeRun(siblings.workdir, "20261023-163019-none", { status: "stopped" });
    const shown = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "20261023-163018-bnlx", "--install", "--workdir", siblings.workdir], shown.runtime)).toBe(0);
    expect(shown.out.join("\n")).toContain("resolving packages\nError: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK");
    const none = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["show", "20261023-163019-none", "--install", "--workdir", siblings.workdir], none.runtime)).toBe(0);
    expect(none.out.join("\n")).toMatch(/did not run an install command/);
  });
});

describe("contribute --check-isolation", () => {
  it("leaves the engine's default alone when the flag is not given", async () => {
    const siblings = fakeSiblings();
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect((siblings.calls[1]?.args[1] as RunOptions).checkIsolation).toBeUndefined();
    expect(asked[0]).not.toMatch(/isolation|sandbox/);
  });

  it("passes strict through and says so in the question the person answers", async () => {
    const siblings = fakeSiblings();
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["y", "n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--check-isolation", "strict", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect((siblings.calls[1]?.args[1] as RunOptions).checkIsolation).toBe("strict");
    expect(asked[0]).toContain("the repository's own commands in a strict sandbox that hides your home directory");
  });

  it("warns plainly when the repository's commands will run without a sandbox", async () => {
    const siblings = fakeSiblings();
    const { runtime, asked } = fakeRuntime({}, { modules: siblings.modules, answers: ["n"] });
    expect(await run(["contribute", "acme/widget", "--issue", "42", "--check-isolation", "none", "--workdir", siblings.workdir], runtime)).toBe(0);
    expect(asked[0]).toContain("the repository's own install and test commands run on this machine WITHOUT a sandbox");
  });

  it("rejects an unknown mode as a usage error before doing anything", async () => {
    const siblings = fakeSiblings();
    const { runtime, err } = fakeRuntime({}, { modules: siblings.modules, answers: ["y"] });
    expect(await run(["contribute", "acme/widget", "--check-isolation", "paranoid", "--workdir", siblings.workdir], runtime)).toBe(2);
    expect(err.join("\n")).toMatch(/auto, sandbox, strict, none/);
    expect(siblings.calls).toHaveLength(0);
  });
});

describe("errors a first-time user meets", () => {
  const fetchFailed = (cause?: unknown) => Object.assign(new TypeError("fetch failed"), cause === undefined ? {} : { cause });

  it("names the host and the cause when the network cannot be reached", async () => {
    const offline = fakeRuntime({
      discover: async () => {
        throw fetchFailed(Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND", hostname: "api.github.com" }));
      },
    });
    expect(await run(["discover", "learn"], offline.runtime)).toBe(1);
    expect(offline.err.join("\n")).toBe("error: could not reach api.github.com (ENOTFOUND). Check your internet connection or proxy settings.");
  });

  it("finds the cause inside an aggregate of connection attempts, and still helps when there is none", async () => {
    const refused = fakeRuntime({
      discover: async () => {
        throw fetchFailed(Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED", address: "127.0.0.1" })], ""), { code: "ECONNREFUSED" }));
      },
    });
    expect(await run(["discover", "learn"], refused.runtime)).toBe(1);
    expect(refused.err.join("\n")).toMatch(/^error: could not reach the network \(ECONNREFUSED\)/);

    const bare = fakeRuntime({
      discover: async () => {
        throw fetchFailed();
      },
    });
    expect(await run(["discover", "learn"], bare.runtime)).toBe(1);
    expect(bare.err.join("\n")).toBe("error: could not reach the network (fetch failed). Check your internet connection or proxy settings.");
  });

  it("explains certificate failures, which usually mean a proxy that inspects TLS", async () => {
    const tls = fakeRuntime({
      discover: async () => {
        throw fetchFailed(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }));
      },
    });
    expect(await run(["discover", "learn"], tls.runtime)).toBe(1);
    expect(tls.err.join("\n")).toMatch(/certificate.*NODE_EXTRA_CA_CERTS/);
  });

  it("says a repository was not found, as explain does, when analyze gets a 404 for it", async () => {
    const siblings = fakeSiblings();
    (siblings.modules["@gitgoblin/intel"] as { analyzeRepository: unknown }).analyzeRepository = async () => {
      throw Object.assign(new Error("HTTP 404 for https://api.github.com/repos/not/a-real-repo"), { name: "GitHubError", status: 404 });
    };
    const { runtime, err } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "not/a-real-repo"], runtime)).toBe(1);
    expect(err.join("\n")).toBe("error: not/a-real-repo was not found on github.com (or it is private and your token cannot see it).");
  });

  it("leaves other 404s alone, since they are not about the repository asked for", async () => {
    const siblings = fakeSiblings();
    (siblings.modules["@gitgoblin/intel"] as { analyzeRepository: unknown }).analyzeRepository = async () => {
      throw Object.assign(new Error("HTTP 404 for https://api.github.com/repos/acme/widget/actions/runs"), { status: 404 });
    };
    const { runtime, err } = fakeRuntime({}, { modules: siblings.modules });
    expect(await run(["analyze", "acme/widget"], runtime)).toBe(1);
    expect(err.join("\n")).toBe("error: HTTP 404 for https://api.github.com/repos/acme/widget/actions/runs");
  });
});
