import { excerpt, execShell, keptOutput, type ExecOptions } from "./exec.ts";
import type { Check, Commands, DiffStats, TestCounts, Verification } from "./types.ts";

export interface CheckSpec {
  name: string;
  command: string;
}

const ORDER: (keyof Commands)[] = ["typecheck", "lint", "build", "test"];

/** The repository's own checks in a sensible order, plus any extra ones (for example a reproduction test). */
export function checkSpecs(commands: Commands, extra: CheckSpec[] = []): CheckSpec[] {
  const specs: CheckSpec[] = [];
  for (const name of ORDER) {
    const command = commands[name];
    if (command) specs.push({ name, command });
  }
  for (const spec of extra) {
    // A reproduction that is just "run the suite" is already covered by the test check.
    if (spec.command && !specs.some((s) => s.name === spec.name || s.command === spec.command)) specs.push(spec);
  }
  return specs;
}

export interface RunChecksOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  wrap?: ExecOptions["wrap"];
  onCheck?: (check: Check) => void;
  /** Receives everything a check printed that was kept, for a log file; `outputTail` holds only an excerpt. */
  onOutput?: (check: Check, output: string) => void;
}

export async function runChecks(specs: CheckSpec[], opts: RunChecksOptions): Promise<Check[]> {
  const checks: Check[] = [];
  for (const spec of specs) {
    const result = await execShell(spec.command, { cwd: opts.cwd, env: opts.env, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.wrap ? { wrap: opts.wrap } : {}) });
    const check: Check = {
      name: spec.name,
      command: spec.command,
      status: result.timedOut ? "timeout" : result.exitCode === 0 ? "pass" : "fail",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputTail: excerpt(result),
    };
    if (result.truncated) {
      // Cut-off output keeps only the summaries in its kept end (the first kept line may be partial), so
      // its failures are a lower bound and its passing tests unknown. A runner's totals usually come last.
      check.truncated = true;
      const tests = testCounts(result.output.slice(result.output.indexOf("\n") + 1));
      if (tests) check.tests = { failed: tests.failed };
    } else {
      const tests = testCounts(result.output);
      if (tests) check.tests = tests;
    }
    checks.push(check);
    opts.onOutput?.(check, keptOutput(result));
    opts.onCheck?.(check);
  }
  return checks;
}

// Colours and hyperlinks; runners that think they write to a terminal wrap their summaries in them.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

type Summary = { failed: number; passed: number | undefined };

/** "3 failed" in a summary line, or 0 when the word is missing. */
function count(text: string, word: string): number {
  const match = new RegExp(`(\\d+) ${word}\\b`).exec(text);
  return match ? Number(match[1]) : 0;
}

/**
 * Summary lines of the test runners gitgoblin meets most, each turned into counts. A command that
 * runs several suites (workspaces, browsers, crates) prints several lines; they are added up.
 */
const RUNNERS: { name: string; read: (out: string) => Summary[] }[] = [
  // vitest: "      Tests  2 failed | 98 passed (100)". "Test Files" lines are not matched.
  { name: "vitest", read: (out) => [...out.matchAll(/^\s*Tests {2,}(.*\d+ (?:passed|failed).*)$/gm)].map(([, l = ""]) => ({ failed: count(l, "failed"), passed: count(l, "passed") })) },
  // jest: "Tests:       1 failed, 2 skipped, 97 passed, 100 total"
  { name: "jest", read: (out) => [...out.matchAll(/^Tests:\s+(.*\btotal)\s*$/gm)].map(([, l = ""]) => ({ failed: count(l, "failed"), passed: count(l, "passed") })) },
  // pytest: "===== 1 failed, 98 passed, 1 error in 2.31s =====". Errors are failures to the person reading.
  {
    name: "pytest",
    read: (out) => [...out.matchAll(/^=+ (.*\b(?:passed|failed|errors?|no tests ran)\b.*) in [\d.]+s\b.*=+\s*$/gm)].map(([, l = ""]) => ({ failed: count(l, "failed") + count(l, "errors?"), passed: count(l, "passed") })),
  },
  // mocha: "  98 passing (2s)" then "  2 failing"; the failing line is absent when nothing failed.
  {
    name: "mocha",
    read: (out) => {
      const passing = [...out.matchAll(/^\s*(\d+) passing\b/gm)];
      if (passing.length === 0) return [];
      const failing = [...out.matchAll(/^\s*(\d+) failing\s*$/gm)];
      return [{ failed: failing.reduce((n, m) => n + Number(m[1]), 0), passed: passing.reduce((n, m) => n + Number(m[1]), 0) }];
    },
  },
  // web-test-runner, one line per browser: "Webkit:   |████| 80/80 test files | 5285 passed, 7 failed, 40 skipped"
  { name: "web-test-runner", read: (out) => [...out.matchAll(/^\s*[^|\n]+:\s*\|[^|\n]*\|\s*\d+\/\d+ test files \|\s*(\d+) passed, (\d+) failed/gm)].map(([, p = "0", f = "0"]) => ({ failed: Number(f), passed: Number(p) })) },
  // node --test and TAP: "# pass 98" / "# fail 2"; node's spec reporter writes "ℹ pass 98".
  {
    name: "tap",
    read: (out) => {
      const pass = [...out.matchAll(/^(?:#|ℹ) pass (\d+)\s*$/gm)];
      const fail = [...out.matchAll(/^(?:#|ℹ) fail (\d+)\s*$/gm)];
      if (pass.length === 0 && fail.length === 0) return [];
      return [{ failed: fail.reduce((n, m) => n + Number(m[1]), 0), passed: pass.reduce((n, m) => n + Number(m[1]), 0) }];
    },
  },
  // bun test: " 98 pass" and " 2 fail" on their own lines, then "Ran 100 tests across 9 files."
  {
    name: "bun",
    read: (out) => {
      if (!/^Ran \d+ tests? across \d+ files?\b/m.test(out)) return [];
      return [{ failed: [...out.matchAll(/^\s*(\d+) fail\s*$/gm)].reduce((n, m) => n + Number(m[1]), 0), passed: [...out.matchAll(/^\s*(\d+) pass\s*$/gm)].reduce((n, m) => n + Number(m[1]), 0) }];
    },
  },
  // cargo test, one line per test binary: "test result: FAILED. 98 passed; 2 failed; 0 ignored; ..."
  { name: "cargo", read: (out) => [...out.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm)].map(([, p = "0", f = "0"]) => ({ failed: Number(f), passed: Number(p) })) },
  // go test prints only failures unless -v, so it has no passing count. A package that does not
  // compile has no "--- FAIL" lines, only "FAIL <pkg> [build failed]"; count it as one failure.
  {
    name: "go",
    read: (out) => {
      if (!/^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[(?:build|setup) failed\]|\[no test files\])/m.test(out)) return [];
      const failed = [...out.matchAll(/^\s*--- FAIL: /gm)].length + [...out.matchAll(/^FAIL\s+\S+\s+\[(?:build|setup) failed\]/gm)].length;
      return [{ failed, passed: undefined }];
    },
  },
  // RSpec: "100 examples, 2 failures, 3 pending"
  { name: "rspec", read: (out) => [...out.matchAll(/^(\d+) examples?, (\d+) failures?/gm)].map(([, e = "0", f = "0"]) => ({ failed: Number(f), passed: Number(e) - Number(f) })) },
  // PHPUnit: "OK (100 tests, 250 assertions)" or "Tests: 100, Assertions: 250, Failures: 2, Errors: 1."
  {
    name: "phpunit",
    read: (out) => [
      ...[...out.matchAll(/^OK \((\d+) tests?, \d+ assertions?\)/gm)].map(([, t = "0"]) => ({ failed: 0, passed: Number(t) })),
      ...[...out.matchAll(/^Tests: (\d+), Assertions: \d+(.*)$/gm)].map(([, t = "0", rest = ""]) => {
        const failed = Number(/Failures: (\d+)/.exec(rest)?.[1] ?? 0) + Number(/Errors: (\d+)/.exec(rest)?.[1] ?? 0);
        return { failed, passed: Math.max(0, Number(t) - failed) };
      }),
    ],
  },
];

/**
 * Failing and passing tests in a check's output, read from the summary lines of the runners above,
 * or undefined when none of them printed one. Pass and fail per command cannot tell a change that
 * broke 500 more tests from one that broke none when the suite already failed before the change;
 * these counts can.
 */
export function testCounts(output: string): TestCounts | undefined {
  const text = output.replace(ANSI, "").replace(/\r/g, "");
  const summaries = RUNNERS.flatMap((runner) => runner.read(text));
  if (summaries.length === 0) return undefined;
  const failed = summaries.reduce((n, s) => n + s.failed, 0);
  const passed = summaries.every((s) => s.passed !== undefined) ? summaries.reduce((n, s) => n + (s.passed ?? 0), 0) : undefined;
  return passed === undefined ? { failed } : { failed, passed };
}

/** True when the counts say the change made an already failing suite worse. */
function worse(now: TestCounts, baseline: TestCounts): boolean {
  if (now.failed > baseline.failed) return true;
  // Fewer passing tests with no more failures: tests that stopped running (a file that no longer loads).
  return now.passed !== undefined && baseline.passed !== undefined && now.passed < baseline.passed;
}

const failed = (c: Check) => c.status === "fail" || c.status === "timeout";

/**
 * Compares a verification run with the baseline taken before any change. A failure that already
 * existed at baseline is reported but does not count against the change, unless the runner's counts
 * show more failing or fewer passing tests than at baseline; everything else must pass. A baseline
 * timeout tells us nothing, so it never excuses a failure.
 */
export function compareWithBaseline(now: Check[], baseline: Check[] | undefined, diff: DiffStats): Verification {
  const before = new Map((baseline ?? []).map((c) => [c.name, c]));
  const regressions: string[] = [];
  const preexisting: string[] = [];
  const testCounts: NonNullable<Verification["testCounts"]> = [];
  let blocking = 0;
  for (const c of now.filter(failed)) {
    const base = before.get(c.name);
    if (base?.status === "pass") {
      regressions.push(c.name);
      blocking += 1;
    } else if (base?.status === "fail" && c.status === "fail") {
      // Counts from a cut-off baseline are a lower bound, which proves nothing about the change.
      const baseline = base.truncated ? undefined : base.tests;
      if (baseline && c.tests) {
        testCounts.push({ name: c.name, baseline, now: c.tests });
        if (worse(c.tests, baseline)) {
          regressions.push(c.name);
          blocking += 1;
        } else preexisting.push(c.name);
      } else if (baseline && !c.truncated) {
        // The runner reported results at baseline and none now: the suite no longer gets that far (a
        // file that does not load, a compile error), which is worse than any count it could report.
        testCounts.push({ name: c.name, baseline });
        regressions.push(c.name);
        blocking += 1;
      } else preexisting.push(c.name);
    } else if (base?.status === "fail") {
      // It failed before and now runs out of time: still the old failure as far as anyone can tell.
      preexisting.push(c.name);
    } else blocking += 1;
  }
  return {
    checks: now,
    regressions,
    ok: blocking === 0,
    diff,
    ...(preexisting.length ? { preexisting } : {}),
    ...(testCounts.length ? { testCounts } : {}),
  };
}

/** "7 failing and 5292 passing tests, against 7 and 5290 on the base commit" for one counted check, or undefined. */
export function describeCounts(v: Verification, name: string): string | undefined {
  const counted = v.testCounts?.find((t) => t.name === name);
  if (!counted) return undefined;
  const { now, baseline } = counted;
  const before = baseline.passed !== undefined ? `${baseline.failed} failing and ${baseline.passed} passing tests` : `${baseline.failed} failing tests`;
  if (!now) return `the test runner reported no results, against ${before} on the base commit`;
  if (v.checks.find((c) => c.name === name)?.truncated) {
    return `at least ${now.failed} failing tests in the end of an output too long to keep whole, against ${before} on the base commit`;
  }
  if (now.passed !== undefined && baseline.passed !== undefined) {
    return `${now.failed} failing and ${now.passed} passing tests, against ${baseline.failed} and ${baseline.passed} on the base commit`;
  }
  return `${now.failed} failing tests, against ${baseline.failed} on the base commit`;
}

export function describeChecks(checks: Check[]): string {
  return checks.map((c) => `- ${c.name}: ${c.status} (${c.command}, ${Math.round(c.durationMs / 1000)}s)`).join("\n");
}
