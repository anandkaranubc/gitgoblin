/**
 * Drives the real @gitgoblin/engine pipeline through the CLI, with a scripted model, on a tiny
 * repository with a real bug. The unit tests use fakes for the siblings; this one proves the fakes
 * tell the truth: the Reporter, approvePlan, RunOptions and publishRun the CLI hands over are what the
 * engine accepts, and the run directory the CLI reads back is the one the engine writes. Only the
 * engine's exported surface is used.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, ChangePlan, ImplementationNotes, Investigation, PhaseResult, PhaseSpec, PublishRunOptions, Review, RunInput, RunOptions } from "@gitgoblin/engine";
import { publishRun, runContribution } from "@gitgoblin/engine";
import { MemoryCache } from "@gitgoblin/sources";
import { describe, expect, it } from "vitest";
import { type Runtime, run } from "../src/index.ts";
import { sampleOpportunity, sampleReport } from "./fixtures.ts";

/** A git identity for the test, so commits work without the developer's global config. */
const env = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  GIT_AUTHOR_NAME: "Test Operator",
  GIT_AUTHOR_EMAIL: "operator@example.com",
  GIT_COMMITTER_NAME: "Test Operator",
  GIT_COMMITTER_EMAIL: "operator@example.com",
};

const BUGGY = "export function paginate(items, page, size) {\n  const start = page * size;\n  return items.slice(start, start + size - 1);\n}\n";
const FIXED = BUGGY.replace("start + size - 1", "start + size");
const REPRO_TEST = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { paginate } from "../src/paginate.js";\n\ntest("last page keeps the final item", () => {\n  assert.deepEqual(paginate([1, 2, 3], 1, 2), [3]);\n});\n';

/** A tiny Node project with a real bug, a passing test suite and a CONTRIBUTING file, committed on main. */
function createFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitgoblin-fixture-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(dir, "src", "paginate.js"), BUGGY);
  writeFileSync(join(dir, "test", "first.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { paginate } from "../src/paginate.js";\n\ntest("empty input", () => {\n  assert.deepEqual(paginate([], 0, 2), []);\n});\n');
  writeFileSync(join(dir, "CONTRIBUTING.md"), "# Contributing\n\nRun `npm test` before opening a pull request.\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Operator");
  git("config", "user.email", "operator@example.com");
  git("add", ".");
  git("commit", "-q", "-m", "chore: initial");
  return dir;
}

// What the model would say in each phase; the files it would write are written by the handlers.
const investigation: Investigation = {
  summary: "The slice end bound is one short.",
  relevantFiles: ["src/paginate.js"],
  rootCause: "start + size - 1 should be start + size",
  reproduction: { kind: "test", path: "test/paginate.test.js", command: "node --test test/paginate.test.js", observed: "fails: expected [3], got []" },
  commands: {},
  feasibility: "proceed",
  reasons: [],
  questions: [],
};
const plan: ChangePlan = {
  goal: "Keep the final item of the last page",
  steps: ["Fix the slice bound in src/paginate.js", "Add a regression test"],
  filesToModify: ["src/paginate.js"],
  filesToCreate: ["test/paginate.test.js"],
  testsToAdd: ["last page keeps the final item"],
  outOfScope: [],
  risks: [],
  needsNewDependency: false,
};
const notes: ImplementationNotes = { summary: "Changed the slice bound.", deviationsFromPlan: [], testsRun: ["npm test"], knownGaps: [], done: true };
const approve: Review = { verdict: "approve", checks: [{ name: "correctness", verdict: "pass", evidence: "bound fixed" }], findings: [], prNotes: "" };

type Handler = (workspace: string) => unknown;
const script: Record<string, Handler> = {
  orient: (ws) => {
    writeFileSync(join(ws, "test", "paginate.test.js"), REPRO_TEST);
    return investigation;
  },
  plan: () => plan,
  implement: (ws) => {
    writeFileSync(join(ws, "src", "paginate.js"), FIXED);
    return notes;
  },
  review: () => approve,
};

/** An AgentRunner that answers each phase from the script instead of a model. */
function scriptedRunner(workspace: string): AgentRunner {
  let counter = 0;
  return {
    async run<T>(spec: PhaseSpec<T>): Promise<PhaseResult<T>> {
      counter += 1;
      const sessionId = spec.resume ?? `session-${counter}`;
      const handler = Object.entries(script).find(([prefix]) => spec.name.startsWith(prefix))?.[1];
      const parsed = handler ? spec.schema.safeParse(handler(workspace)) : undefined;
      if (!parsed?.success) return { ok: false, text: "", sessionId, costUsd: 0.01, turns: 1, durationMs: 1, errors: [parsed ? parsed.error.message : `no script for ${spec.name}`], denials: [] };
      return { ok: true, output: parsed.data, text: "", sessionId, costUsd: 0.05, turns: 3, durationMs: 1, errors: [], denials: [] };
    },
  };
}

/** Intel's report for the fixture: the engine works in a worktree of the local checkout. */
function fixtureReport(localPath: string) {
  const report = sampleReport([
    sampleOpportunity({
      id: "acme/fixture#7",
      repo: { host: "github.com", owner: "acme", name: "fixture" },
      title: "paginate() drops the last item of the final page",
      summary: "Slicing uses size - 1, so the final element of every page is lost.",
      files: ["src/paginate.js"],
      issue: { number: 7, url: "https://github.com/acme/fixture/issues/7", title: "paginate drops the last item", labels: ["bug"], assignees: [], inFlight: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" },
      acceptanceCriteria: ["paginate([1,2,3], 1, 2) returns [3]"],
    }),
  ]);
  report.profile.repo = { host: "github.com", owner: "acme", name: "fixture", localPath };
  report.profile.ecosystems = [{ name: "node", manifests: ["package.json"], packageManager: "npm", tooling: [], commands: { test: "npm test" } }];
  return report;
}

function journeyRuntime(localPath: string, answers: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const report = fixtureReport(localPath);
  const modules: Record<string, Record<string, unknown>> = {
    "@gitgoblin/intel": {
      analyzeRepository: async () => report,
      renderMarkdown: () => "# acme/fixture",
      AnalysisReport: { parse: (value: unknown) => value },
    },
    "@gitgoblin/engine": {
      // The real engine, with a scripted model and the test git identity; publishing is a dry run.
      runContribution: (input: RunInput, options: RunOptions) => runContribution(input, { ...options, env, runnerFactory: (ctx) => scriptedRunner(ctx.workspace) }),
      publishRun: (runId: string, options: PublishRunOptions) => publishRun(runId, { ...options, env, dryRun: true }),
    },
  };
  const runtime: Runtime = {
    loadModule: async (name) => modules[name],
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    canPrompt: true,
    async createEngine() {
      return { engine: { discover: async () => [], explain: async () => undefined }, close() {}, rateLimits: () => "" };
    },
    openCache: () => new MemoryCache(),
    cachePath: () => "/tmp/unused",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    color: false,
    isInteractive: false,
    env: {},
  };
  return { runtime, out, err, asked };
}

describe("the contribute journey against the real engine", () => {
  it("runs a fixture bug to a prepared pull request, shows it, and publishes as a dry run; then runs/show find it", { timeout: 120_000 }, async () => {
    const repo = createFixtureRepo();
    const workdir = mkdtempSync(join(tmpdir(), "gitgoblin-journey-"));
    const { runtime, out, err, asked } = journeyRuntime(repo, ["y", "y", "y"]);

    expect(await run(["contribute", "acme/fixture", "--issue", "7", "--workdir", workdir], runtime)).toBe(0);

    // The person approved what actually happens: a worktree of their checkout, not a clone.
    expect(asked[0]).toContain(`in a git worktree of ${repo}`);

    // Progress came through the Reporter the CLI built.
    const progress = err.join("\n");
    expect(progress).toMatch(/==> run: \S+ for paginate\(\) drops the last item/);
    expect(progress).toContain("==> orient");
    expect(progress).toContain("==> prepare: commit and pull request text");

    // The plan was shown in words before implementation.
    expect(asked[1]).toContain("Plan: Keep the final item of the last page");
    expect(asked[1]).toContain("  1. Fix the slice bound in src/paginate.js");

    // What the engine did was shown before the publish question.
    const printed = out.join("\n");
    expect(printed).toContain("Run awaiting_approval: ready for human review");
    expect(printed).toContain("Status: **awaiting_approval**");
    expect(printed).toContain("Proposed pull request: fix: keep the final item of the last page");
    expect(printed).toContain("Fixes #7");
    expect(printed).toContain("| `npm test` | pass |");
    const runId = /gitgoblin publish (\S+)/.exec(printed)?.[1];
    expect(runId).toBeTruthy();
    expect(existsSync(join(workdir, "runs", runId!, "diff.patch"))).toBe(true);
    expect(asked[2]).toMatch(/draft pull request/);
    expect(printed).toContain("Draft pull request: (dry run)");

    // The lifecycle commands read what the engine wrote.
    const runs = journeyRuntime(repo, []);
    expect(await run(["runs", "--workdir", workdir], runs.runtime)).toBe(0);
    expect(runs.out.join("\n")).toContain(`${runId}  awaiting_approval  $`);
    expect(runs.out.join("\n")).toContain("acme/fixture  paginate() drops the last item of the final page");

    const diff = journeyRuntime(repo, []);
    expect(await run(["show", runId!, "--diff", "--workdir", workdir], diff.runtime)).toBe(0);
    expect(diff.out.join("\n")).toContain("+  return items.slice(start, start + size);");

    const pr = journeyRuntime(repo, []);
    expect(await run(["show", runId!, "--pr", "--workdir", workdir], pr.runtime)).toBe(0);
    expect(pr.out.join("\n")).toContain("fix: keep the final item of the last page");
  });
});
