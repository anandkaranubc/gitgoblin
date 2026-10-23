import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunner, PhaseResult, PhaseSpec } from "../../src/agent.ts";
import { git } from "../../src/workspace.ts";
import type { ChangePlan, ImplementationNotes, Investigation, Review, Task } from "../../src/types.ts";
import { TaskSchema } from "../../src/types.ts";

export const env = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  GIT_AUTHOR_NAME: "Test Operator",
  GIT_AUTHOR_EMAIL: "operator@example.com",
  GIT_COMMITTER_NAME: "Test Operator",
  GIT_COMMITTER_EMAIL: "operator@example.com",
};

export const BUGGY = `export function paginate(items, page, size) {\n  const start = page * size;\n  return items.slice(start, start + size - 1);\n}\n`;
export const FIXED = BUGGY.replace("start + size - 1", "start + size");
export const REPRO_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { paginate } from "../src/paginate.js";\n\ntest("last page keeps the final item", () => {\n  assert.deepEqual(paginate([1, 2, 3], 1, 2), [3]);\n});\n`;

/** A tiny Node project with a real bug, a passing test suite and a CONTRIBUTING file. */
export async function createFixtureRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gg-fixture-"));
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "test"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(path.join(dir, "src", "paginate.js"), BUGGY);
  writeFileSync(path.join(dir, "test", "first.test.js"), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { paginate } from "../src/paginate.js";\n\ntest("empty input", () => {\n  assert.deepEqual(paginate([], 0, 2), []);\n});\n`);
  writeFileSync(path.join(dir, "CONTRIBUTING.md"), "# Contributing\n\nRun `npm test` before opening a pull request.\n");
  await git(["init", "-q", "-b", "main"], dir, env);
  await git(["config", "user.name", "Test Operator"], dir, env);
  await git(["config", "user.email", "operator@example.com"], dir, env);
  await git(["add", "."], dir, env);
  await git(["commit", "-q", "-m", "chore: initial"], dir, env);
  return dir;
}

export function fixtureTask(localPath: string): Task {
  return TaskSchema.parse({
    id: "fixture#1",
    repo: { owner: "acme", name: "fixture", localPath },
    commands: { test: "npm test" },
    conventions: { commitStyle: "conventional" },
    kind: "issue",
    title: "paginate() drops the last item of the final page",
    summary: "Slicing uses size - 1, so the final element of every page is lost.",
    issue: { number: 7, labels: ["bug"] },
    acceptanceCriteria: ["paginate([1,2,3], 1, 2) returns [3]"],
  });
}

export const investigation: Investigation = {
  summary: "The slice end bound is one short.",
  relevantFiles: ["src/paginate.js"],
  rootCause: "start + size - 1 should be start + size",
  reproduction: { kind: "test", path: "test/paginate.test.js", command: "node --test test/paginate.test.js", observed: "fails: expected [3], got []" },
  commands: {},
  feasibility: "proceed",
  reasons: [],
  questions: [],
};

export const plan: ChangePlan = {
  goal: "Keep the final item of the last page",
  steps: ["Fix the slice bound in src/paginate.js", "Add a regression test"],
  filesToModify: ["src/paginate.js"],
  filesToCreate: ["test/paginate.test.js"],
  testsToAdd: ["last page keeps the final item"],
  outOfScope: ["pagination of negative pages"],
  risks: [],
  needsNewDependency: false,
};

export const notes: ImplementationNotes = { summary: "Changed the slice bound.", deviationsFromPlan: [], testsRun: ["npm test"], knownGaps: [], done: true };

export const approve: Review = {
  verdict: "approve",
  checks: [{ name: "correctness", verdict: "pass", evidence: "bound fixed" }],
  findings: [],
  prNotes: "",
};

export type PhaseHandler = (spec: PhaseSpec<unknown>, workspace: string) => unknown | Promise<unknown>;

/** Runs phases from a script instead of a model. Handlers are matched by phase-name prefix. */
export function scriptedRunner(workspace: string, handlers: Record<string, PhaseHandler>, calls: PhaseSpec<unknown>[] = []): AgentRunner {
  let counter = 0;
  return {
    async run<T>(spec: PhaseSpec<T>): Promise<PhaseResult<T>> {
      calls.push(spec as PhaseSpec<unknown>);
      const key = Object.keys(handlers).find((k) => spec.name.startsWith(k));
      counter += 1;
      const sessionId = spec.resume ?? `session-${counter}`;
      if (!key) return { ok: false, text: "", sessionId, costUsd: 0.01, turns: 1, durationMs: 1, errors: ["no handler"], denials: [] };
      const raw = await handlers[key]!(spec as PhaseSpec<unknown>, workspace);
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) return { ok: false, text: JSON.stringify(raw), sessionId, costUsd: 0.01, turns: 1, durationMs: 1, errors: [parsed.error.message], denials: [] };
      return { ok: true, output: parsed.data, text: "", sessionId, costUsd: 0.05, turns: 3, durationMs: 1, errors: [], denials: [] };
    },
  };
}
