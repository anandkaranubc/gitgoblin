import { describe, expect, it } from "vitest";
import { afterDiff, afterOrient, topDirectories, atIntake, afterPlan, afterReview, afterVerify, checkBudget, controlsChecks, DEFAULT_LIMITS, failureSignature, findSecrets, isProtectedPath, packageJsonControlChanged } from "../src/policy.ts";
import type { ChangePlan, Investigation, Review, Task, Verification } from "../src/types.ts";
import { TaskSchema } from "../src/types.ts";

const task: Task = TaskSchema.parse({ id: "t", repo: { owner: "o", name: "n" }, title: "t" });

const investigation: Investigation = {
  summary: "s",
  relevantFiles: [],
  rootCause: "",
  reproduction: { kind: "none", path: "", command: "", observed: "" },
  commands: {},
  feasibility: "proceed",
  reasons: [],
  questions: [],
};

const plan: ChangePlan = {
  goal: "g",
  steps: ["do it"],
  filesToModify: ["src/a.ts"],
  filesToCreate: [],
  testsToAdd: ["a test"],
  outOfScope: [],
  risks: [],
  needsNewDependency: false,
};

function verification(failing: string[] = [], tail = "boom"): Verification {
  const names = ["test", "lint"];
  return {
    checks: names.map((name) => ({
      name,
      command: name,
      status: failing.includes(name) ? "fail" : "pass",
      exitCode: failing.includes(name) ? 1 : 0,
      durationMs: 1,
      outputTail: failing.includes(name) ? tail : "ok",
    })),
    regressions: failing,
    ok: failing.length === 0,
    diff: { files: 1, insertions: 1, deletions: 0, changedFiles: ["src/a.ts"] },
  };
}

function review(verdict: Review["verdict"], findings: Review["findings"] = []): Review {
  return { verdict, checks: [], findings, prNotes: "" };
}

describe("afterOrient", () => {
  it("continues when feasible", () => expect(afterOrient(investigation)).toEqual({ action: "continue" }));
  it("stops with the reasons", () => {
    expect(afterOrient({ ...investigation, feasibility: "stop", reasons: ["already fixed"] })).toEqual({ action: "stop", reason: "already fixed" });
  });
  it("escalates with questions", () => {
    const d = afterOrient({ ...investigation, feasibility: "needs_human", reasons: ["ambiguous"], questions: ["which?"] });
    expect(d).toEqual({ action: "escalate", reason: "ambiguous", questions: ["which?"] });
  });
});

describe("afterPlan", () => {
  it("continues for a modest plan", () => expect(afterPlan(plan, task, DEFAULT_LIMITS)).toEqual({ action: "continue" }));
  it("stops on an empty plan", () => expect(afterPlan({ ...plan, steps: [] }, task, DEFAULT_LIMITS).action).toBe("stop"));
  it("escalates when too many files", () => {
    const files = Array.from({ length: 21 }, (_, i) => `f${i}.ts`);
    expect(afterPlan({ ...plan, filesToModify: files }, task, DEFAULT_LIMITS).action).toBe("escalate");
  });
  it("escalates on protected paths unless the task is about CI", () => {
    const ci = { ...plan, filesToModify: [".github/workflows/ci.yml"] };
    expect(afterPlan(ci, task, DEFAULT_LIMITS).action).toBe("escalate");
    expect(afterPlan(ci, { ...task, kind: "ci_rot" }, DEFAULT_LIMITS).action).toBe("continue");
    expect(afterPlan({ ...plan, filesToCreate: [".env"] }, { ...task, kind: "ci_rot" }, DEFAULT_LIMITS).action).toBe("escalate");
  });
  it("escalates when a dependency is needed", () => {
    expect(afterPlan({ ...plan, needsNewDependency: true }, task, DEFAULT_LIMITS).action).toBe("escalate");
  });
});

describe("isProtectedPath", () => {
  it("matches secrets and CI files", () => {
    expect(isProtectedPath("./.env.local", task)).toBe(true);
    expect(isProtectedPath("certs/server.pem", task)).toBe(true);
    expect(isProtectedPath("Jenkinsfile", task)).toBe(true);
    expect(isProtectedPath("src/env.ts", task)).toBe(false);
  });
});

describe("afterVerify", () => {
  it("continues when ok", () => expect(afterVerify(verification(), 1, undefined, DEFAULT_LIMITS)).toEqual({ action: "continue" }));
  it("retries with the failed checks", () => {
    expect(afterVerify(verification(["test"]), 1, undefined, DEFAULT_LIMITS)).toEqual({ action: "retry", reason: "verification failed: test" });
  });
  it("escalates on a repeated failure", () => {
    const v = verification(["test"], "expected 1 got 2 at line 10");
    const again = verification(["test"], "expected 1 got 2 at line 11");
    expect(afterVerify(again, 2, failureSignature(v), DEFAULT_LIMITS).action).toBe("escalate");
  });
  it("escalates after the last allowed attempt", () => {
    expect(afterVerify(verification(["lint"]), DEFAULT_LIMITS.maxImplementRounds, "other", DEFAULT_LIMITS).action).toBe("escalate");
  });
});

describe("afterReview", () => {
  const blocker: Review["findings"][number] = { severity: "blocker", file: "src/a.ts", line: 3, summary: "Null deref", failureScenario: "x", suggestion: "y" };
  it("continues on approve", () => expect(afterReview(review("approve"), 1, 1, [], DEFAULT_LIMITS)).toEqual({ action: "continue" }));
  it("escalates on reject", () => expect(afterReview(review("reject"), 1, 1, [], DEFAULT_LIMITS).action).toBe("escalate"));
  it("treats revise with only nits as approve", () => {
    const nit = { ...blocker, severity: "nit" as const };
    expect(afterReview(review("revise", [nit]), 1, 1, [], DEFAULT_LIMITS)).toEqual({ action: "continue" });
  });
  it("retries on a fresh blocker", () => {
    expect(afterReview(review("revise", [blocker]), 1, 1, [], DEFAULT_LIMITS).action).toBe("retry");
  });
  it("escalates when a blocker survives a revision", () => {
    expect(afterReview(review("revise", [blocker]), 2, 2, ["src/a.ts:null deref"], DEFAULT_LIMITS).action).toBe("escalate");
  });
  it("escalates after the last review round or the last implementation attempt", () => {
    expect(afterReview(review("revise", [blocker]), 2, 2, [], DEFAULT_LIMITS).action).toBe("escalate");
    expect(afterReview(review("revise", [blocker]), 1, DEFAULT_LIMITS.maxImplementRounds, [], DEFAULT_LIMITS).action).toBe("escalate");
  });
});

describe("checkBudget", () => {
  it("stops over cost or time", () => {
    expect(checkBudget(11, 0, DEFAULT_LIMITS).action).toBe("stop");
    expect(checkBudget(0, DEFAULT_LIMITS.maxWallClockMs + 1, DEFAULT_LIMITS).action).toBe("stop");
    expect(checkBudget(1, 1, DEFAULT_LIMITS).action).toBe("continue");
  });
});

describe("afterDiff", () => {
  const diff = (files: string[]) => ({ files: files.length, insertions: 1, deletions: 0, changedFiles: files });
  it("escalates when the diff is wider than the plan was allowed to be", () => {
    expect(afterDiff(diff(["src/a.ts"]), task, DEFAULT_LIMITS)).toEqual({ action: "continue" });
    expect(afterDiff(diff(Array.from({ length: 21 }, (_, i) => `f${i}`)), task, DEFAULT_LIMITS).action).toBe("escalate");
    expect(afterDiff(diff(["src/a.ts", ".github/workflows/ci.yml"]), task, DEFAULT_LIMITS).action).toBe("escalate");
  });
});

describe("findSecrets", () => {
  it("flags secret-looking additions only", () => {
    expect(findSecrets("+const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';")).toEqual(["GitHub token"]);
    expect(findSecrets("-const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n+const token = process.env.TOKEN;")).toEqual([]);
    expect(findSecrets("+-----BEGIN RSA PRIVATE KEY-----")).toEqual(["private key"]);
    expect(findSecrets("+++ b/src/a.ts\n+const id = 'AKIAIOSFODNN7EXAMPLE';")).toEqual(["AWS access key"]);
  });
});

describe("atIntake", () => {
  it("only lets code changes through", () => {
    expect(atIntake(task)).toEqual({ action: "continue" });
    expect(atIntake({ ...task, issue: { number: 1, labels: [], inFlight: true } }).action).toBe("stop");
    expect(atIntake({ ...task, kind: "triage" }).action).toBe("stop");
    expect(atIntake({ ...task, kind: "stale_pr" }).action).toBe("escalate");
    expect(atIntake({ ...task, kind: "hygiene", files: [] }).action).toBe("escalate");
    expect(atIntake({ ...task, kind: "hygiene", files: [".editorconfig"] })).toEqual({ action: "continue" });
  });
});

describe("controlsChecks", () => {
  it.each([
    "package.json",
    "packages/a/package.json",
    "Makefile",
    "GNUmakefile",
    "justfile",
    "Rakefile",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "noxfile.py",
    "conftest.py",
    "tests/conftest.py",
    "pytest.ini",
    "Cargo.toml",
    "build.rs",
    ".cargo/config.toml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle.kts",
    "gradlew",
    "pom.xml",
    "mvnw",
    ".mvn/wrapper/maven-wrapper.properties",
    "CMakeLists.txt",
    "meson.build",
    "BUILD.bazel",
    ".npmrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "vitest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    ".mocharc.cjs",
    "eslint.config.js",
    ".eslintrc.js",
    "babel.config.js",
    ".babelrc",
    "vite.config.mts",
    "webpack.config.js",
    "rollup.config.mjs",
    "playwright.config.ts",
    "tsup.config.ts",
    ".husky/pre-commit",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    ".envrc",
    "composer.json",
    "phpunit.xml",
    "phpunit.xml.dist",
    "mix.exs",
    "Package.swift",
    "build.zig",
    "build.sbt",
  ])("knows %s decides what the check commands run", (file) => expect(controlsChecks(file)).toBe(true));

  it.each(["src/paginate.js", "test/paginate.test.js", "README.md", "tsconfig.json", "package-lock.json", "docs/config.md", "src/Makefile.md", "config/settings.json"])(
    "leaves %s alone",
    (file) => expect(controlsChecks(file)).toBe(false),
  );
});

describe("packageJsonControlChanged", () => {
  const base = JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "vitest run" }, dependencies: { a: "1" } });
  it("ignores edits that do not touch what the commands execute", () => {
    expect(packageJsonControlChanged(base, JSON.stringify({ name: "x", version: "1.0.1", scripts: { test: "vitest run" }, dependencies: { a: "2" }, description: "d" }))).toBe(false);
  });
  it("flags script, workspace, lifecycle and package-manager changes", () => {
    expect(packageJsonControlChanged(base, JSON.stringify({ name: "x", scripts: { test: "node -e 1" } }))).toBe(true);
    expect(packageJsonControlChanged(base, JSON.stringify({ name: "x", scripts: { test: "vitest run", pretest: "node x.js" } }))).toBe(true);
    expect(packageJsonControlChanged(base, JSON.stringify({ name: "x", scripts: { test: "vitest run" }, workspaces: ["../evil"] }))).toBe(true);
    expect(packageJsonControlChanged(base, JSON.stringify({ name: "x", scripts: { test: "vitest run" }, packageManager: "pnpm@9" }))).toBe(true);
  });
  it("treats unparsable or missing content as a change", () => {
    expect(packageJsonControlChanged(base, "{ not json")).toBe(true);
    expect(packageJsonControlChanged(undefined, base)).toBe(true);
    expect(packageJsonControlChanged(base, undefined)).toBe(true);
  });
});

describe("topDirectories", () => {
  it("names where most of a large change lives", () => {
    const files = [...Array.from({ length: 300 }, (_, i) => `.pnpm-store/v10/files/${i}`), "src/a.ts", "test/a.test.ts", "README.md"];
    const top = topDirectories(files);
    expect(top[0]).toBe(".pnpm-store/ (300)");
    expect(top).toHaveLength(3);
  });
});

describe("afterDiff on a huge change", () => {
  it("says where the files are, so a person can act on it", () => {
    const changedFiles = [...Array.from({ length: 50 }, (_, i) => `.pnpm-store/x/${i}`), "src/a.ts"];
    const d = afterDiff({ files: changedFiles.length, insertions: 1, deletions: 0, changedFiles }, task, DEFAULT_LIMITS);
    expect(d.action).toBe("escalate");
    expect(d.action === "escalate" && d.reason).toMatch(/mostly \.pnpm-store\/ \(50\)/);
  });
});
