import { describe, expect, it } from "vitest";
import { checkSpecs, compareWithBaseline, describeCounts, runChecks, testCounts } from "../src/verify.ts";
import type { Check, DiffStats, TestCounts } from "../src/types.ts";

const env = { PATH: process.env["PATH"] ?? "" };
const diff: DiffStats = { files: 0, insertions: 0, deletions: 0, changedFiles: [] };
const check = (name: string, status: Check["status"], tests?: TestCounts): Check => ({ name, command: name, status, exitCode: status === "pass" ? 0 : 1, durationMs: 0, outputTail: "", ...(tests ? { tests } : {}) });

describe("checkSpecs", () => {
  it("orders known commands and appends extras once", () => {
    const specs = checkSpecs({ test: "npm test", lint: "eslint .", install: "npm ci" }, [{ name: "repro", command: "npm test -- repro" }, { name: "test", command: "dup" }, { name: "same", command: "npm test" }]);
    expect(specs.map((s) => s.name)).toEqual(["lint", "test", "repro"]);
  });
});

describe("runChecks", () => {
  it("records pass, fail and timeout", async () => {
    const checks = await runChecks(
      [{ name: "ok", command: "true" }, { name: "bad", command: "echo nope; exit 2" }, { name: "slow", command: "sleep 3" }],
      { cwd: process.cwd(), env, timeoutMs: 200 },
    );
    expect(checks.map((c) => c.status)).toEqual(["pass", "fail", "timeout"]);
    expect(checks[1]?.outputTail).toContain("nope");
  });
  it("hands over the whole output and keeps its start in the excerpt", async () => {
    const outputs: Record<string, string> = {};
    const [long] = await runChecks([{ name: "test", command: "echo 'browserType.launch failed'; yes filler | head -c 20000; echo done; exit 1" }], {
      cwd: process.cwd(),
      env,
      onOutput: (c, output) => {
        outputs[c.name] = output;
      },
    });
    expect(outputs["test"]?.length).toBeGreaterThan(20000);
    expect(long?.outputTail.length).toBeLessThan(6200);
    expect(long?.outputTail.startsWith("browserType.launch failed")).toBe(true);
    expect(long?.outputTail.trimEnd().endsWith("done")).toBe(true);
  });
  it("records the runner's test counts when it prints a summary", async () => {
    const [counted, plain] = await runChecks(
      [{ name: "test", command: "printf '      Tests  1 failed | 2 passed (3)\\n'; exit 1" }, { name: "lint", command: "echo 'no summary here'; exit 1" }],
      { cwd: process.cwd(), env },
    );
    expect(counted?.tests).toEqual({ failed: 1, passed: 2 });
    expect(plain?.tests).toBeUndefined();
  });
});

describe("testCounts", () => {
  const cases: [string, string, TestCounts | undefined][] = [
    ["vitest", " Test Files  1 failed | 9 passed (10)\n      Tests  2 failed | 98 passed | 1 skipped (101)\n   Duration  1.2s", { failed: 2, passed: 98 }],
    ["vitest in colour", "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m98 passed\u001b[39m\u001b[22m\u001b[90m (100)\u001b[39m", { failed: 2, passed: 98 }],
    ["vitest in two workspaces", "      Tests  3 passed (3)\n      Tests  1 failed | 4 passed (5)", { failed: 1, passed: 7 }],
    ["jest", "Test Suites: 1 failed, 4 passed, 5 total\nTests:       2 failed, 1 skipped, 97 passed, 100 total\nSnapshots:   0 total", { failed: 2, passed: 97 }],
    ["pytest", "FAILED tests/test_a.py::test_x\n=========== 2 failed, 97 passed, 1 error in 3.21s ===========", { failed: 3, passed: 97 }],
    ["pytest, all passing", "============ 100 passed in 1.02s (0:00:01) ============", { failed: 0, passed: 100 }],
    ["mocha", "  98 passing (2s)\n  1 pending\n  2 failing\n\n  1) suite\n", { failed: 2, passed: 98 }],
    ["web-test-runner, three browsers", "Chromium: |████| 80/80 test files | 5292 passed, 0 failed, 40 skipped\nFirefox:  |████| 80/80 test files | 0 passed, 0 failed\nWebkit:   |████| 80/80 test files | 5285 passed, 7 failed, 40 skipped\n\nFinished running tests in 274s with 7 failed tests.", { failed: 7, passed: 10577 }],
    ["node --test", "ℹ tests 100\nℹ suites 4\nℹ pass 98\nℹ fail 2\nℹ cancelled 0", { failed: 2, passed: 98 }],
    ["TAP", "not ok 3 - adds\n1..100\n# tests 100\n# pass 98\n# fail 2", { failed: 2, passed: 98 }],
    ["bun", " 98 pass\n 2 fail\n 250 expect() calls\nRan 100 tests across 9 files. [1.20s]", { failed: 2, passed: 98 }],
    ["cargo, two test binaries", "test result: FAILED. 98 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\ntest result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out", { failed: 2, passed: 108 }],
    ["go test", "--- FAIL: TestA (0.00s)\n    a_test.go:9: wrong\n--- FAIL: TestB (0.00s)\nFAIL\nFAIL\texample.com/x\t0.01s\nFAIL\texample.com/y [build failed]\nok  \texample.com/z\t0.02s", { failed: 3 }],
    ["rspec", "Finished in 1.2 seconds\n100 examples, 2 failures, 3 pending", { failed: 2, passed: 98 }],
    ["phpunit, failing", "Tests: 100, Assertions: 250, Failures: 2, Errors: 1.", { failed: 3, passed: 97 }],
    ["phpunit, passing", "OK (100 tests, 250 assertions)", { failed: 0, passed: 100 }],
    ["no known runner", "src/a.ts(3,1): error TS2304: Cannot find name 'x'.\nFound 1 error.", undefined],
  ];
  it.each(cases)("reads %s", (_name, output, expected) => {
    expect(testCounts(output)).toEqual(expected);
  });
});

describe("compareWithBaseline", () => {
  it("blames only new failures", () => {
    const baseline = [check("lint", "fail"), check("test", "pass")];
    const v = compareWithBaseline([check("lint", "fail"), check("test", "pass"), check("repro", "pass")], baseline, diff);
    expect(v.ok).toBe(true);
    expect(v.regressions).toEqual([]);
    const bad = compareWithBaseline([check("lint", "fail"), check("test", "fail")], baseline, diff);
    expect(bad.ok).toBe(false);
    expect(bad.regressions).toEqual(["test"]);
  });
  it("does not let a baseline timeout excuse a failure", () => {
    const v = compareWithBaseline([check("test", "fail")], [check("test", "timeout")], diff);
    expect(v.ok).toBe(false);
  });
  it("fails new checks that fail without a baseline", () => {
    const v = compareWithBaseline([check("repro", "fail")], undefined, diff);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([]);
  });
});

describe("compareWithBaseline with test counts", () => {
  const before = [check("test", "fail", { failed: 7, passed: 10577 })];
  it("keeps a suite that fails the same way as before a pre-existing failure", () => {
    const v = compareWithBaseline([check("test", "fail", { failed: 7, passed: 10580 })], before, diff);
    expect(v.ok).toBe(true);
    expect(v.preexisting).toEqual(["test"]);
    expect(describeCounts(v, "test")).toBe("7 failing and 10580 passing tests, against 7 and 10577 on the base commit");
  });
  it("blames the change for more failing tests in a suite that already failed", () => {
    const v = compareWithBaseline([check("test", "fail", { failed: 507, passed: 10077 })], before, diff);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual(["test"]);
    expect(v.preexisting).toBeUndefined();
  });
  it("blames the change for tests that stopped running", () => {
    const v = compareWithBaseline([check("test", "fail", { failed: 7, passed: 9000 })], before, diff);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual(["test"]);
  });
  it("accepts fewer failures", () => {
    const v = compareWithBaseline([check("test", "fail", { failed: 3, passed: 10581 })], before, diff);
    expect(v.ok).toBe(true);
  });
  it("compares failures alone when the runner prints no passing count", () => {
    const base = [check("test", "fail", { failed: 2 })];
    expect(compareWithBaseline([check("test", "fail", { failed: 2 })], base, diff).ok).toBe(true);
    expect(compareWithBaseline([check("test", "fail", { failed: 3 })], base, diff).ok).toBe(false);
    expect(describeCounts(compareWithBaseline([check("test", "fail", { failed: 2 })], base, diff), "test")).toBe("2 failing tests, against 2 on the base commit");
  });
  it("falls back to pass and fail when either side has no counts", () => {
    expect(compareWithBaseline([check("test", "fail")], before, diff).ok).toBe(true);
    expect(compareWithBaseline([check("test", "fail", { failed: 900 })], [check("test", "fail")], diff).ok).toBe(true);
  });
  it("still treats a timeout after a baseline failure as the old failure", () => {
    const v = compareWithBaseline([check("test", "timeout")], before, diff);
    expect(v.ok).toBe(true);
    expect(v.preexisting).toEqual(["test"]);
  });
});
