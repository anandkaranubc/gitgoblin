/**
 * Guards the contract with @gitgoblin/intel: a profile and opportunity that intel's own zod
 * schemas accept must map into a Task. Imported from intel's source so no build step is needed.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnalysisReport, ContributionOpportunity, RepositoryProfile } from "../../intel/src/contracts.ts";
import { taskFromIntel } from "../src/intake.ts";
import { atIntake, DEFAULT_LIMITS } from "../src/policy.ts";

const FIXTURE = new URL("../../intel/fixtures/tenacity.report.json", import.meta.url);

const profile = RepositoryProfile.parse({
  repo: { host: "github.com", owner: "acme", name: "widgets", localPath: "/tmp/widgets" },
  analyzedAt: "2026-10-22T00:00:00Z",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  defaultBranch: "main",
  topics: [],
  stars: 10,
  forks: 1,
  archived: false,
  isFork: false,
  nature: "library",
  natureReason: "has a package manifest",
  languages: [{ name: "TypeScript", bytes: 1000, share: 1 }],
  ecosystems: [{ name: "node", manifests: ["package.json"], packageManager: "npm", tooling: ["vitest"], commands: { install: "npm ci", test: "npm test", lint: "npm run lint" } }],
  ci: { provider: "github_actions", workflows: ["ci.yml"] },
  structure: { fileCount: 10, analyzedFileCount: 10, sourceDirs: ["src"], testDirs: ["test"], docsDirs: [], entryPoints: ["src/index.ts"] },
  activity: { commits90d: 5, commits365d: 20, authors90d: 2, authors365d: 3, busFactor: 1, openIssues: 4, openPullRequests: 1, sampleSizes: { issues: 4, pullRequests: 1, externalPullRequests: 0 } },
  welcomeness: {
    score: 0.7,
    level: "open",
    signals: [],
    rules: { contributingPath: "CONTRIBUTING.md", requiresIssueFirst: false, cla: false, dco: true, issueTemplates: true, pullRequestTemplate: true, pullRequestTemplatePath: ".github/pull_request_template.md", requiresTests: true, requiresChangelog: false, helpLabels: ["good first issue"], rejectedChanges: ["typo-only pull requests"], dependencyBot: true },
  },
  conventions: { commitStyle: "conventional", recentCommitSubjects: ["fix: a", "feat: b"], testFramework: "vitest" },
  hotFiles: [],
  instructionFiles: ["AGENTS.md"],
  notes: [],
});

const opportunity = ContributionOpportunity.parse({
  id: "acme/widgets#42",
  repo: { host: "github.com", owner: "acme", name: "widgets" },
  kind: "issue",
  title: "paginate() drops the last item",
  summary: "Off-by-one in the slice bound.",
  evidence: [{ id: "e1", kind: "issue", locator: "https://github.com/acme/widgets/issues/42", observedAt: "2026-10-22T00:00:00Z" }],
  factors: [{ name: "confidence", score: 0.9, reason: "clear reproduction in the issue" }],
  score: 0.8,
  effort: "small",
  skills: ["typescript"],
  files: ["src/paginate.ts"],
  issue: { number: 42, url: "https://github.com/acme/widgets/issues/42", title: "paginate drops last item", labels: ["bug"], assignees: [], inFlight: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" },
  approach: ["fix the bound", "add a test"],
  acceptanceCriteria: ["last page includes the final item"],
  etiquette: ["link the issue"],
  risks: [],
});

describe("intel contract compatibility", () => {
  it("maps a schema-valid profile and opportunity into a Task", () => {
    const task = taskFromIntel(profile, opportunity);
    expect(task.repo).toMatchObject({ host: "github.com", owner: "acme", name: "widgets", localPath: "/tmp/widgets", headSha: profile.headSha, defaultBranch: "main" });
    expect(task.commands).toMatchObject({ install: "npm ci", test: "npm test", lint: "npm run lint" });
    expect(task.conventions).toMatchObject({ commitStyle: "conventional", recentCommitSubjects: ["fix: a", "feat: b"], testFramework: "vitest" });
    expect(task.rules).toMatchObject({ contributingPath: "CONTRIBUTING.md", prTemplatePath: ".github/pull_request_template.md", dco: true, requiresTests: true, requiresChangelog: false, instructionFiles: ["AGENTS.md"], rejectedChanges: ["typo-only pull requests"] });
    expect(task.issue).toMatchObject({ number: 42, labels: ["bug"], inFlight: false });
    expect(task).toMatchObject({ id: "acme/widgets#42", kind: "issue", effort: "small", files: ["src/paginate.ts"], approach: ["fix the bound", "add a test"] });
  });
});

describe("intel's real fixture report", () => {
  it.skipIf(!existsSync(FIXTURE))("maps every opportunity into a Task and classifies it at intake", () => {
    const report = AnalysisReport.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
    expect(report.opportunities.length).toBeGreaterThan(0);
    for (const opportunity of report.opportunities) {
      const task = taskFromIntel(report.profile, opportunity);
      expect(task.repo.owner).toBe(report.profile.repo.owner);
      expect(task.id).toBe(opportunity.id);
      expect(["continue", "stop", "escalate"]).toContain(atIntake(task).action);
    }
    expect(DEFAULT_LIMITS.maxFilesChanged).toBeGreaterThan(0);
  });
});
