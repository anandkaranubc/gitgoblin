import { describe, expect, it } from "vitest";
import { parseTask, sanitizeText, taskFromIntel } from "../src/intake.ts";

const profile = {
  repo: { host: "github.com", owner: "acme", name: "widgets", localPath: "/tmp/widgets" },
  headSha: "abc123",
  defaultBranch: "develop",
  nature: "library",
  ecosystems: [
    { name: "python", commands: { test: "pytest" } },
    { name: "node", packageManager: "npm", commands: { install: "npm ci", test: "npm test", lint: "npm run lint" } },
  ],
  conventions: { commitStyle: "conventional", testFramework: "vitest", recentCommitSubjects: ["fix: a", "feat: b"] },
  welcomeness: {
    score: 0.8,
    rules: { contributingPath: "CONTRIBUTING.md", pullRequestTemplate: true, pullRequestTemplatePath: ".github/pull_request_template.md", dco: true, requiresTests: true },
  },
  instructionFiles: ["AGENTS.md"],
  extraFieldIntelAddedLater: { nested: true },
};

const opportunity = {
  id: "acme/widgets#42",
  kind: "issue",
  title: "Fix off-by-one in paginate()​",
  summary: "paginate drops the last item",
  issue: { number: 42, url: "https://github.com/acme/widgets/issues/42", labels: ["bug", "good first issue"], inFlight: false },
  files: ["src/paginate.ts"],
  approach: ["add a failing test", "fix the bound"],
  acceptanceCriteria: ["last page includes the final item"],
  etiquette: ["link the issue"],
  risks: [],
  effort: "small",
  factors: [{ name: "confidence", score: 0.9, reason: "clear repro" }],
};

describe("taskFromIntel", () => {
  it("projects intel contracts onto a Task", () => {
    const task = taskFromIntel(profile, opportunity);
    expect(task.repo).toMatchObject({ host: "github.com", owner: "acme", name: "widgets", localPath: "/tmp/widgets", defaultBranch: "develop", headSha: "abc123" });
    expect(task.repo.cloneUrl).toBe("https://github.com/acme/widgets.git");
    // One coherent command set: the ecosystem that runs tests wins, nothing is mixed in from the others.
    expect(task.commands).toEqual({ install: undefined, test: "pytest", build: undefined, lint: undefined, typecheck: undefined, format: undefined });
    expect(task.conventions.commitStyle).toBe("conventional");
    expect(task.conventions.recentCommitSubjects).toEqual(["fix: a", "feat: b"]);
    expect(task.rules).toMatchObject({ contributingPath: "CONTRIBUTING.md", prTemplatePath: ".github/pull_request_template.md", dco: true, requiresTests: true, instructionFiles: ["AGENTS.md"] });
    expect(task.issue).toMatchObject({ number: 42, labels: ["bug", "good first issue"] });
    expect(task.title).toBe("Fix off-by-one in paginate()");
    expect(task.effort).toBe("small");
  });

  it("prefers the ecosystem that knows how to run tests", () => {
    const task = taskFromIntel({ ...profile, ecosystems: [{ commands: { build: "make" } }, { commands: { test: "go test ./..." } }] }, opportunity);
    expect(task.commands.test).toBe("go test ./...");
    expect(task.commands.build).toBeUndefined();
  });

  it("applies defaults when intel knows little", () => {
    const task = taskFromIntel({ repo: { owner: "a", name: "b" } }, { id: "x", title: "t" });
    expect(task.repo.defaultBranch).toBe("main");
    expect(task.repo.host).toBe("github.com");
    expect(task.kind).toBe("issue");
    expect(task.files).toEqual([]);
    expect(task.rules.instructionFiles).toEqual([]);
    expect(task.conventions.recentCommitSubjects).toEqual([]);
  });

  it("rejects input without an owner", () => {
    expect(() => taskFromIntel({ repo: { name: "b" } }, { id: "x", title: "t" })).toThrow();
  });
});

describe("sanitizeText", () => {
  it("strips zero-width and bidi characters but keeps newlines", () => {
    expect(sanitizeText("a​b‮c\nd\te")).toBe("abc\nd\te");
  });
});

describe("TaskSchema repository fields", () => {
  const base = { id: "x", title: "t", repo: { owner: "acme", name: "widgets" } };
  it("accepts ordinary identifiers, shas, branches and clone urls", () => {
    const task = parseTask({ ...base, repo: { ...base.repo, host: "codeberg.org", headSha: "abc123", defaultBranch: "release/2.x", cloneUrl: "https://codeberg.org/acme/widgets.git" } });
    expect(task.repo.host).toBe("codeberg.org");
    expect(() => parseTask({ ...base, repo: { ...base.repo, cloneUrl: "file:///tmp/repo" } })).not.toThrow();
    expect(() => parseTask({ ...base, repo: { ...base.repo, cloneUrl: "git@github.com:acme/widgets.git" } })).not.toThrow();
    expect(() => parseTask({ ...base, repo: { owner: "a.b-c_d", name: "x.y" } })).not.toThrow();
  });
  it.each([
    { owner: "../etc", name: "w" },
    { owner: "acme", name: "w/x" },
    { owner: "acme", name: ".." },
    { owner: "-acme", name: "w" },
    { owner: "acme", name: "w", host: "evil host" },
    { owner: "acme", name: "w", headSha: "--output=/tmp/x" },
    { owner: "acme", name: "w", headSha: "main" },
    { owner: "acme", name: "w", defaultBranch: "-x" },
    { owner: "acme", name: "w", defaultBranch: "a..b" },
    { owner: "acme", name: "w", defaultBranch: "has space" },
    { owner: "acme", name: "w", cloneUrl: "ext::sh -c id" },
    { owner: "acme", name: "w", cloneUrl: "-oProxyCommand=id" },
  ])("rejects repo fields that could change what git does: %o", (repo) => {
    expect(() => parseTask({ ...base, repo })).toThrow();
  });
});
