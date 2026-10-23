import { describe, expect, it } from "vitest";
import { checkSpecs, compareWithBaseline, runChecks } from "../src/verify.ts";
import type { Check, DiffStats } from "../src/types.ts";

const env = { PATH: process.env["PATH"] ?? "" };
const diff: DiffStats = { files: 0, insertions: 0, deletions: 0, changedFiles: [] };
const check = (name: string, status: Check["status"]): Check => ({ name, command: name, status, exitCode: status === "pass" ? 0 : 1, durationMs: 0, outputTail: "" });

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
