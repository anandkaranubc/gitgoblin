import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisReport, ContributionOpportunity } from "@gitgoblin/intel";

const AT = "2026-10-22T00:00:00Z";

/** Writes the files the engine leaves in runs/<id>/ (see packages/engine/README.md). */
export function writeRun(workdir: string, runId: string, overrides: { status?: string; reason?: string; title?: string; costUsd?: number; prepared?: boolean; install?: { exitCode: number | null; output: string; timedOut?: boolean; refused?: string[]; network?: string }; workspaceBytes?: number } = {}): string {
  const dir = join(workdir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  const status = overrides.status ?? "awaiting_approval";
  writeFileSync(join(dir, "result.json"), JSON.stringify({ runId, runDir: dir, status, reason: overrides.reason ?? "ready for human review", questions: [], workspace: join(dir, "workspace"), branch: "gitgoblin/fix-42", costUsd: overrides.costUsd ?? 0.42, durationMs: 61_000 }));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ id: "opp-aaaa1111", repo: { host: "github.com", owner: "acme", name: "widget" }, title: overrides.title ?? "Fix #42: --color flag is ignored on Windows", kind: "issue" }));
  writeFileSync(join(dir, "report.md"), `# gitgoblin run ${runId}\n\n- Status: **${status}**\n`);
  if (overrides.install) writeInstall(dir, overrides.install);
  if (overrides.workspaceBytes !== undefined) {
    // What the engine leaves: a workspace folder inside the run, recorded in workspace.json.
    mkdirSync(join(dir, "workspace", "node_modules"), { recursive: true });
    writeFileSync(join(dir, "workspace", "node_modules", "blob.bin"), Buffer.alloc(overrides.workspaceBytes));
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({ path: join(dir, "workspace"), branch: "gitgoblin/fix-42", baseSha: "0123456", source: "clone" }));
  }
  if (overrides.prepared ?? status === "awaiting_approval") {
    writeFileSync(join(dir, "pr-title.txt"), "fix: honour --color on Windows\n");
    writeFileSync(join(dir, "pr.md"), "## Summary\n\nFixes #42\n");
    writeFileSync(join(dir, "diff.patch"), "diff --git a/src/main.rs b/src/main.rs\n");
  }
  return dir;
}

/** One opportunity shaped exactly like intel produces, with overrides for the fields a test cares about. */
export function sampleOpportunity(overrides: Partial<ContributionOpportunity> = {}): ContributionOpportunity {
  return {
    id: "opp-aaaa1111",
    repo: { host: "github.com", owner: "acme", name: "widget" },
    kind: "issue",
    title: "Fix #42: --color flag is ignored on Windows",
    summary: "The flag is parsed but never reaches the renderer on Windows.",
    evidence: [{ id: "e1", kind: "issue", locator: "https://github.com/acme/widget/issues/42", observedAt: AT }],
    factors: [{ name: "confidence", score: 0.9, reason: "clear reproduction in the issue" }],
    score: 0.72,
    effort: "small",
    skills: ["rust"],
    files: ["src/main.rs"],
    issue: { number: 42, url: "https://github.com/acme/widget/issues/42", title: "--color flag is ignored on Windows", labels: ["bug"], assignees: [], inFlight: false, createdAt: AT, updatedAt: AT },
    approach: ["Thread the flag through to the renderer", "Add a test"],
    acceptanceCriteria: ["--color never prints escape codes on Windows"],
    etiquette: ["Reference the issue in the pull request"],
    risks: [],
    ...overrides,
  };
}

/** A whole report: a plausible profile and three opportunities of different kinds. */
export function sampleReport(opportunities: ContributionOpportunity[] = defaultOpportunities()): AnalysisReport {
  return {
    version: "1",
    profile: {
      repo: { host: "github.com", owner: "acme", name: "widget" },
      analyzedAt: AT,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      defaultBranch: "main",
      description: "Widgets for everyone",
      topics: ["widgets"],
      stars: 1234,
      forks: 56,
      license: "MIT",
      archived: false,
      isFork: false,
      nature: "cli",
      natureReason: "has a binary entry point",
      languages: [{ name: "Rust", bytes: 1000, share: 1 }],
      ecosystems: [{ name: "rust", manifests: ["Cargo.toml"], packageManager: "cargo", tooling: ["cargo"], commands: { build: "cargo build", test: "cargo test" } }],
      ci: { provider: "github_actions", workflows: [".github/workflows/ci.yml"] },
      structure: { fileCount: 20, analyzedFileCount: 18, sourceDirs: ["src"], testDirs: ["tests"], docsDirs: [], entryPoints: ["src/main.rs"] },
      activity: { commits90d: 12, commits365d: 80, authors90d: 3, authors365d: 6, busFactor: 2, openIssues: 7, openPullRequests: 1, sampleSizes: { issues: 7, pullRequests: 1, externalPullRequests: 1 } },
      welcomeness: {
        score: 0.7,
        level: "open",
        signals: [],
        rules: { contributingPath: "CONTRIBUTING.md", requiresIssueFirst: false, cla: false, dco: false, issueTemplates: true, pullRequestTemplate: false, requiresTests: true, requiresChangelog: false, helpLabels: ["good first issue"], rejectedChanges: [], dependencyBot: false },
      },
      conventions: { commitStyle: "conventional", recentCommitSubjects: ["fix: a", "feat: b"], testFramework: "cargo test" },
      hotFiles: [],
      instructionFiles: [],
      notes: [],
    },
    opportunities,
    skipped: [{ kind: "broken_link", title: "Dead link in README", reason: "below threshold (score 0.21)" }],
    budget: { apiRequests: 12, httpChecks: 0, cloneMs: 1500, totalMs: 9000, truncated: false, notes: ["workflow runs unavailable: no token"] },
  };
}

function defaultOpportunities(): ContributionOpportunity[] {
  return [
    sampleOpportunity(),
    sampleOpportunity({
      id: "opp-bbbb2222",
      kind: "issue",
      title: "Fix #57: panic on empty config",
      summary: "An empty config file panics instead of using defaults.",
      score: 0.61,
      evidence: [{ id: "e2", kind: "issue", locator: "https://github.com/acme/widget/issues/57", observedAt: AT }],
      issue: { number: 57, url: "https://github.com/acme/widget/issues/57", title: "panic on empty config", labels: ["bug"], assignees: ["someone"], inFlight: true, createdAt: AT, updatedAt: AT },
    }),
    sampleOpportunity({
      id: "opp-cccc3333",
      kind: "triage",
      title: "Triage #61: unclear feature request",
      summary: "Needs a reply asking for a concrete example.",
      score: 0.4,
      effort: "trivial",
      skills: ["communication"],
      files: [],
      evidence: [{ id: "e3", kind: "issue", locator: "https://github.com/acme/widget/issues/61", observedAt: AT }],
      issue: { number: 61, url: "https://github.com/acme/widget/issues/61", title: "unclear feature request", labels: [], assignees: [], inFlight: false, createdAt: AT, updatedAt: AT },
    }),
  ];
}

/** The engine's record of the install step: an event in events.jsonl and the full output beside it. */
export function writeInstall(dir: string, install: { exitCode: number | null; output: string; timedOut?: boolean; refused?: string[]; network?: string }): void {
  const events = [
    { ts: "2026-10-23T16:30:19.000Z", phase: "run", type: "start" },
    { ts: "2026-10-23T16:30:20.000Z", phase: "install", type: "end", exitCode: install.exitCode, durationMs: 68, timedOut: install.timedOut ?? false, outputTail: install.output.slice(-2000), ...(install.network ? { network: install.network } : {}), ...(install.refused ? { refused: install.refused } : {}) },
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "install-output.txt"), install.output);
}
