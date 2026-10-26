/**
 * Every string the CLI prints that came from a repository, an issue, a registry, the engine or a run
 * file can carry terminal escape sequences: OSC 52 sets the clipboard, CSI moves the cursor to rewrite
 * lines the person already read. This feeds such text into every field and every command, and asserts
 * that none of it reaches the terminal.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryResult } from "@gitgoblin/core";
import type { RunOptions, RunResult } from "@gitgoblin/engine";
import type { AnalysisReport } from "@gitgoblin/intel";
import { MemoryCache } from "@gitgoblin/sources";
import { describe, expect, it } from "vitest";
import { type Runtime, run } from "../src/index.ts";
import { sampleOpportunity, sampleReport, writeRun } from "./fixtures.ts";

const EVIL = "\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[2A\u009b31m‮";
const evil = (text: string) => `${text}${EVIL}`;

function hostileResult(): DiscoveryResult {
  return {
    repo: { host: "github.com", owner: "acme", name: "widget", url: evil("https://github.com/acme/widget"), description: evil("Widgets"), topics: [evil("t")], language: evil("Rust"), license: evil("MIT"), stars: 10, forks: 1, openIssues: 1, archived: false, fork: false },
    goal: "contribute",
    score: 0.5,
    reasons: [
      { signal: "activity", weight: 0.1, detail: evil("active") },
      { signal: "filter", weight: -0.1, detail: evil("filtered") },
    ],
    signals: { activity: 0.5, busFactor: 1.6 },
    evidence: {},
    issues: [{ number: 1, title: evil("issue"), url: evil("https://github.com/acme/widget/issues/1"), labels: [], createdAt: "2026-10-01T00:00:00Z" }],
  };
}

function hostileReport(): AnalysisReport {
  const report = sampleReport([
    sampleOpportunity({ id: "opp-aaaa1111", title: evil("Fix #42: title"), summary: evil("summary"), risks: [evil("risk")], factors: [{ name: "confidence", score: 0.3, reason: evil("doubt") }] }),
    sampleOpportunity({ id: "opp-bbbb2222", title: evil("Fix #57: other") }),
  ]);
  report.profile.repo = { host: "github.com", owner: "acme", name: "widget", localPath: evil("/work/widget") };
  report.profile.ecosystems = [{ name: "node", manifests: [], tooling: [], commands: { test: evil("npm test") } }];
  report.budget.notes = [evil("issue and PR samples unavailable: refused")];
  return report;
}

function hostileRuntime(workdir: string, answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const report = hostileReport();
  const modules: Record<string, Record<string, unknown>> = {
    "@gitgoblin/intel": {
      analyzeRepository: async (_ref: unknown, options: { log?: (m: string) => void }) => {
        options.log?.(evil("intel progress"));
        return report;
      },
      renderMarkdown: () => evil("# report"),
      AnalysisReport: { parse: (v: unknown) => v },
    },
    "@gitgoblin/engine": {
      runContribution: async (_input: unknown, options: RunOptions): Promise<RunResult> => {
        options.reporter!.phase(evil("phase"), evil("detail"));
        options.reporter!.info(evil("info"));
        options.reporter!.warn(evil("warn"));
        const runDir = join(options.workdir!, "runs", "20261024-000000-evil");
        writeRun(options.workdir!, "20261024-000000-evil", { status: "escalated", reason: evil("reason"), install: { exitCode: 1, output: evil("install log"), refused: [evil("host")] } });
        return { runId: "20261024-000000-evil", runDir, status: "escalated", reason: evil("reason"), questions: [evil("question")], workspace: undefined, branch: undefined, costUsd: 0, durationMs: 0 };
      },
      publishRun: async (_id: string, options: { log?: (l: string) => void }) => {
        options.log?.(evil("pushing"));
        return { url: evil("https://github.com/acme/widget/pull/1"), head: "", pushedTo: "", commands: [] };
      },
      cleanRun: async () => {
        throw new Error(evil("cannot clean"));
      },
    },
  };
  const runtime: Runtime = {
    loadModule: async (name) => modules[name],
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    canPrompt: true,
    async createEngine({ onProgress }) {
      onProgress({ stage: "warning", message: evil("search refused") });
      return {
        engine: {
          discover: async () => [hostileResult()],
          explain: async () => hostileResult(),
        },
        close() {},
        rateLimits: () => "",
      };
    },
    openCache: () => new MemoryCache(),
    cachePath: () => "/tmp/unused",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    color: false,
    isInteractive: true,
    env: {},
  };
  return { runtime, out, err, asked, all: () => [...out, ...err, ...asked].join("\n") };
}

const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

describe("text from outside never reaches the terminal raw", () => {
  const workdir = () => mkdtempSync(join(tmpdir(), "gitgoblin-hostile-"));

  it.each([
    ["discover", ["discover", "contribute", "--verbose"]],
    ["explain", ["explain", "acme/widget", "--verbose"]],
    ["analyze", ["analyze", "acme/widget", "--verbose"]],
  ])("in %s", async (_name, argv) => {
    const h = hostileRuntime(workdir());
    await run(argv, h.runtime);
    expect(h.all()).not.toMatch(RAW);
  });

  it("in contribute: the list, the choice, the reporter, the result and the install summary", async () => {
    const dir = workdir();
    const h = hostileRuntime(dir, ["nope", "1", "y"]);
    await run(["contribute", "acme/widget", "--workdir", dir], h.runtime);
    expect(h.all()).toContain("Fix #42: title");
    expect(h.all()).not.toMatch(RAW);
  });

  it("in runs, show, publish errors, clean errors and the final error line", async () => {
    const dir = workdir();
    writeRun(dir, "20261024-000000-evil", { status: "escalated", reason: evil("reason"), title: evil("task") });
    writeRun(dir, "20261024-000001-prep", { status: "awaiting_approval", title: evil("task") });
    writeFileSync(join(dir, "runs", "20261024-000001-prep", "pr-title.txt"), evil("fix: title"));
    for (const argv of [["runs"], ["show", "20261024-000000-evil"], ["publish", "20261024-000000-evil"], ["clean", "20261024-000000-evil"], ["publish", "20261024-000001-prep"]]) {
      const h = hostileRuntime(dir, ["n"]);
      await run([...argv, "--workdir", dir], h.runtime);
      expect(h.all(), argv.join(" ")).not.toMatch(RAW);
    }
  });

  it("survives run files of the wrong shape instead of aborting the whole list", async () => {
    const dir = workdir();
    writeRun(dir, "20261024-000002-good", { status: "stopped" });
    writeRun(dir, "20261024-000003-bad", { status: "stopped" });
    writeFileSync(join(dir, "runs", "20261024-000003-bad", "result.json"), JSON.stringify({ status: 7, reason: { not: "text" } }));
    writeRun(dir, "20261024-000004-empty", { status: "stopped" });
    writeFileSync(join(dir, "runs", "20261024-000004-empty", "result.json"), "{}");
    const h = hostileRuntime(dir);
    expect(await run(["runs", "--workdir", dir], h.runtime)).toBe(0);
    expect(h.out.join("\n")).toContain("20261024-000002-good");
  });
});
