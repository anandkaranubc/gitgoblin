import type { Conventions, Ecosystem } from "../contracts.ts";
import type { Commit } from "../git/repo.ts";
import type { GitHubSamples } from "../github/types.ts";
import { isBotLogin } from "../github/types.ts";
import { median } from "../util/time.ts";

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?: /;

export function inferConventions(commits: Commit[], samples: GitHubSamples | undefined, ecosystems: Ecosystem[]): Conventions {
  const human = commits.filter((c) => !isBotLogin(c.authorName) && !/^Merge /.test(c.subject)).slice(0, 100);
  const ratio = human.length ? human.filter((c) => CONVENTIONAL.test(c.subject)).length / human.length : 0;
  const conventions: Conventions = {
    commitStyle: human.length < 5 ? "unknown" : ratio >= 0.6 ? "conventional" : ratio <= 0.2 ? "freeform" : "unknown",
    recentCommitSubjects: human.slice(0, 8).map((c) => c.subject),
  };

  const merged = (samples?.closedPrs ?? []).filter((p) => p.merged && !p.author?.isBot);
  const branch = branchPattern(merged.map((p) => p.headRefName));
  if (branch) conventions.branchNaming = branch;
  const size = median(merged.map((p) => p.additions + p.deletions));
  if (size !== undefined) conventions.typicalPrSizeLines = Math.round(size);

  const tooling = new Set(ecosystems.flatMap((e) => e.tooling));
  const pick = (candidates: string[]) => candidates.find((t) => tooling.has(t));
  const testFramework = pick(["pytest", "unittest", "vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "rspec", "phpunit", "cargo", "go"]);
  const formatter = pick(["ruff", "black", "prettier", "biome", "rustfmt", "gofmt", "rubocop"]);
  const linter = pick(["ruff", "flake8", "pylint", "eslint", "biome", "clippy", "golangci-lint", "rubocop"]);
  const typeChecker = pick(["mypy", "pyright", "typescript"]);
  if (testFramework) conventions.testFramework = testFramework === "cargo" ? "cargo test" : testFramework === "go" ? "go test" : testFramework;
  if (formatter) conventions.formatter = formatter === "ruff" ? "ruff format" : formatter;
  if (linter) conventions.linter = linter;
  if (typeChecker) conventions.typeChecker = typeChecker === "typescript" ? "tsc" : typeChecker;
  return conventions;
}

/** Describe how merged PR branches are named, when a majority follows one pattern. */
export function branchPattern(names: string[]): string | undefined {
  const candidates = names.filter((n) => n && !/^(main|master|develop|dev|patch-\d+|dependabot\/|renovate\/)/.test(n));
  if (candidates.length < 3) return undefined;
  const typed = candidates.filter((n) => /^[a-z]+\/[\w.-]+$/i.test(n));
  if (typed.length / candidates.length >= 0.5) {
    const prefixes = new Map<string, number>();
    for (const n of typed) prefixes.set(n.split("/")[0]!, (prefixes.get(n.split("/")[0]!) ?? 0) + 1);
    const top = [...prefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => `${p}/<topic>`);
    return top.join(", ");
  }
  if (candidates.filter((n) => /^(issue|gh|fix)?-?\d+[-_]/i.test(n)).length / candidates.length >= 0.5) return "<issue-number>-<topic>";
  if (candidates.filter((n) => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(n)).length / candidates.length >= 0.5) return "kebab-case-topic";
  return undefined;
}
