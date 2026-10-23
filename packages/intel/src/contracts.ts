/**
 * Contracts between gitgoblin components.
 *
 * Discovery hands intel a `RepoRef`. Intel returns an `AnalysisReport`
 * holding a `RepositoryProfile` (what the repo is and how it works) and a
 * ranked list of `ContributionOpportunity` (what is worth doing and why).
 * The engine consumes those two types to plan and execute contributions.
 *
 * Every claim an opportunity makes must be backed by `Evidence` a human can
 * check, and every score must decompose into named factors with reasons.
 * Timestamps are ISO 8601 strings.
 */
import { z } from "zod";

/** Owner and repository names as forges allow them; they also become a cache directory name. */
const RepoName = z.string().min(1).max(200).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/, "letters, digits, dots, dashes and underscores only");
/** A git ref name: nothing git could read as an option or a path escape. */
const GitRefName = z.string().min(1).max(250).regex(/^[^\s~^:?*[\\-][^\s~^:?*[\\\x00-\x1f]*$/, "not a valid git ref name").refine((r) => !r.includes("..") && !r.endsWith(".lock") && !r.endsWith("/"), "not a valid git ref name");

export const RepoRef = z.object({
  /** Hostname of the forge, e.g. "github.com". Mirrors RepoRef in @gitgoblin/core. */
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/).default("github.com"),
  owner: RepoName,
  name: RepoName,
  /** Branch, tag, or commit to analyze. Defaults to the default branch. */
  ref: GitRefName.optional(),
  /** Analyze an existing checkout instead of cloning. */
  localPath: z.string().optional(),
});
export type RepoRef = z.infer<typeof RepoRef>;
/** What callers may pass: host defaults to github.com. */
export type RepoRefInput = z.input<typeof RepoRef>;

export const EvidenceKind = z.enum([
  "file",
  "commit",
  "issue",
  "pull_request",
  "workflow_run",
  "http",
  "api",
  "computed",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  id: z.string(),
  kind: EvidenceKind,
  /** Where to look: `path:line`, an issue or PR URL, a commit SHA, an API endpoint, or a URL. */
  locator: z.string(),
  /** Short verbatim excerpt supporting the claim. */
  excerpt: z.string().optional(),
  /** What this evidence shows, in one sentence. */
  note: z.string().optional(),
  observedAt: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const OpportunityKind = z.enum([
  /** An open issue worth fixing. */
  "issue",
  /** A maintainer-endorsed feature request with no implementation underway. */
  "feature_request",
  /** An abandoned pull request with maintainer interest, worth reviving. */
  "stale_pr",
  /** An unanswered issue that needs reproduction or an answer. */
  "triage",
  /** CI that will break or has broken: deprecated actions, retired runners, unsafe triggers. */
  "ci_rot",
  /** Use of deprecated or removed APIs and libraries. */
  "deprecation",
  /** Vulnerable or deprecated dependencies. */
  "dependency",
  /** Documentation that contradicts the code. */
  "docs_drift",
  /** Dead links or references in documentation. */
  "broken_link",
  /** Frequently changed code with no tests, or tests that are skipped. */
  "test_gap",
  /** Self-admitted technical debt with enough context to act on. */
  "tech_debt",
  /** Missing project scaffolding that the repository's nature warrants. */
  "hygiene",
]);
export type OpportunityKind = z.infer<typeof OpportunityKind>;

export const Effort = z.enum(["trivial", "small", "medium", "large"]);
export type Effort = z.infer<typeof Effort>;

export const FactorName = z.enum([
  /** Benefit to the project and its users if done. */
  "value",
  /** Can an outsider realistically do this with what the repo provides? */
  "feasibility",
  /** Will the maintainers want and review it? */
  "welcomeness",
  /** How sure we are the finding is real. */
  "confidence",
  /** Nobody else is already doing it. */
  "novelty",
]);
export type FactorName = z.infer<typeof FactorName>;

export const ScoreFactor = z.object({
  name: FactorName,
  score: z.number().min(0).max(1),
  reason: z.string(),
});
export type ScoreFactor = z.infer<typeof ScoreFactor>;

export const IssueRef = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  /** Someone appears to be working on it already (assignee, linked PR, or recent claim). */
  inFlight: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueRef = z.infer<typeof IssueRef>;

export const ContributionOpportunity = z.object({
  id: z.string(),
  repo: RepoRef,
  kind: OpportunityKind,
  title: z.string(),
  /** One to three sentences: what is wrong and why it matters. */
  summary: z.string(),
  evidence: z.array(Evidence).min(1),
  factors: z.array(ScoreFactor),
  /** Weighted aggregate of `factors`, used for ranking. */
  score: z.number().min(0).max(1),
  effort: Effort,
  /** Skills a contributor needs, e.g. "python", "github-actions", "docs". */
  skills: z.array(z.string()),
  /** Files to read first, repo-relative. */
  files: z.array(z.string()),
  issue: IssueRef.optional(),
  /** Concrete steps a contributor would take. */
  approach: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  /** How to behave: comment first, sign a CLA, follow the PR template. */
  etiquette: z.array(z.string()),
  /** Reasons this might be rejected or wasted. */
  risks: z.array(z.string()),
});
export type ContributionOpportunity = z.infer<typeof ContributionOpportunity>;

export const RepoNature = z.enum([
  "library",
  "application",
  "cli",
  "framework",
  "plugin",
  "docs",
  "awesome_list",
  "tutorial",
  "template",
  "config",
  "data",
  "research",
  "unknown",
]);
export type RepoNature = z.infer<typeof RepoNature>;

export const Language = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  /** Fraction of all language bytes, 0 to 1. */
  share: z.number().min(0).max(1),
});
export type Language = z.infer<typeof Language>;

export const EcosystemName = z.enum([
  "python",
  "node",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
  "dotnet",
  "c_cpp",
  "swift",
  "dart",
  "elixir",
  "other",
]);
export type EcosystemName = z.infer<typeof EcosystemName>;

export const Commands = z.object({
  install: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  lint: z.string().optional(),
  format: z.string().optional(),
  typecheck: z.string().optional(),
});
export type Commands = z.infer<typeof Commands>;

export const Ecosystem = z.object({
  name: EcosystemName,
  /** Manifest files found, repo-relative. */
  manifests: z.array(z.string()),
  packageManager: z.string().optional(),
  /** Tools detected from manifests and config files: pytest, ruff, eslint, cargo, ... */
  tooling: z.array(z.string()),
  /**
   * Best-guess commands a contributor would run, derived from manifests and CI. The strings are
   * repository-authored (a workflow `run:` line, a package script): show or sandbox them, never trust them.
   */
  commands: Commands,
  /** Declared runtime constraint, e.g. "python >=3.9" or "node >=18". */
  runtime: z.string().optional(),
});
export type Ecosystem = z.infer<typeof Ecosystem>;

export const CiInfo = z.object({
  provider: z.enum(["github_actions", "other", "none"]),
  /** Workflow files, repo-relative. */
  workflows: z.array(z.string()),
  /** Conclusion of the most recent completed run on the default branch, if known. */
  lastRunConclusion: z.string().optional(),
  lastRunAt: z.string().optional(),
});
export type CiInfo = z.infer<typeof CiInfo>;

export const Structure = z.object({
  fileCount: z.number().int().nonnegative(),
  /** Files actually examined (after excluding vendored, generated, and binary files). */
  analyzedFileCount: z.number().int().nonnegative(),
  sourceDirs: z.array(z.string()),
  testDirs: z.array(z.string()),
  docsDirs: z.array(z.string()),
  entryPoints: z.array(z.string()),
});
export type Structure = z.infer<typeof Structure>;

export const Activity = z.object({
  lastPushAt: z.string().optional(),
  commits90d: z.number().int().nonnegative(),
  commits365d: z.number().int().nonnegative(),
  authors90d: z.number().int().nonnegative(),
  authors365d: z.number().int().nonnegative(),
  /** Smallest number of authors responsible for half of the last year's commits. */
  busFactor: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  openPullRequests: z.number().int().nonnegative(),
  /** Days between the last few releases, if the project publishes releases. */
  releaseCadenceDays: z.number().nonnegative().optional(),
  lastReleaseAt: z.string().optional(),
  /** Hours from issue creation to the first maintainer response, median over a recent sample. */
  medianIssueResponseHours: z.number().nonnegative().optional(),
  medianPrResponseHours: z.number().nonnegative().optional(),
  /** Share of recently closed PRs from non-maintainers that were merged. */
  externalPrMergeRate: z.number().min(0).max(1).optional(),
  /** Size of the sample behind the two medians and the merge rate. */
  sampleSizes: z.object({
    issues: z.number().int().nonnegative(),
    pullRequests: z.number().int().nonnegative(),
    externalPullRequests: z.number().int().nonnegative(),
  }),
});
export type Activity = z.infer<typeof Activity>;

export const WelcomenessLevel = z.enum([
  /** Archived, read-only mirror, or explicitly not accepting contributions. */
  "closed",
  /** Alive on paper, but nobody responds. */
  "dormant",
  /** Maintained, but outside work is merged rarely or under strict rules. */
  "selective",
  /** Maintained and responsive; outside PRs get merged. */
  "open",
  /** Actively asks for help and merges outsiders quickly. */
  "eager",
]);
export type WelcomenessLevel = z.infer<typeof WelcomenessLevel>;

export const WelcomenessSignal = z.object({
  signal: z.string(),
  /** Positive helps, negative hurts. Magnitude is relative, not a probability. */
  weight: z.number(),
  evidence: Evidence,
});
export type WelcomenessSignal = z.infer<typeof WelcomenessSignal>;

export const ContributionRules = z.object({
  contributingPath: z.string().optional(),
  codeOfConductPath: z.string().optional(),
  /** CONTRIBUTING asks for an issue or discussion before a PR. */
  requiresIssueFirst: z.boolean(),
  cla: z.boolean(),
  dco: z.boolean(),
  issueTemplates: z.boolean(),
  pullRequestTemplate: z.boolean(),
  pullRequestTemplatePath: z.string().optional(),
  /** CONTRIBUTING asks for tests with changes. */
  requiresTests: z.boolean(),
  /** CONTRIBUTING asks for a changelog entry with changes. */
  requiresChangelog: z.boolean(),
  /** Label names the project uses to invite help. */
  helpLabels: z.array(z.string()),
  /** Kinds of change the maintainers say they do not want, quoted from their docs. */
  rejectedChanges: z.array(z.string()),
  /** A bot already handles dependency updates (Dependabot, Renovate). */
  dependencyBot: z.boolean(),
});
export type ContributionRules = z.infer<typeof ContributionRules>;

export const Welcomeness = z.object({
  score: z.number().min(0).max(1),
  level: WelcomenessLevel,
  signals: z.array(WelcomenessSignal),
  rules: ContributionRules,
});
export type Welcomeness = z.infer<typeof Welcomeness>;

export const Conventions = z.object({
  /** "conventional" when most recent commit subjects look like `type(scope): subject`. */
  commitStyle: z.enum(["conventional", "freeform", "unknown"]),
  /** Observed branch naming pattern on merged PRs, e.g. "fix/<topic>". */
  branchNaming: z.string().optional(),
  /** Real recent commit subjects, so a contributor can match the house style. */
  recentCommitSubjects: z.array(z.string()),
  testFramework: z.string().optional(),
  formatter: z.string().optional(),
  linter: z.string().optional(),
  typeChecker: z.string().optional(),
  /** Median size of recently merged PRs in changed lines, as a hint for how big a change should be. */
  typicalPrSizeLines: z.number().nonnegative().optional(),
});
export type Conventions = z.infer<typeof Conventions>;

export const HotFile = z.object({
  path: z.string(),
  commits365d: z.number().int().nonnegative(),
  authors365d: z.number().int().nonnegative(),
});
export type HotFile = z.infer<typeof HotFile>;

export const RepositoryProfile = z.object({
  repo: RepoRef,
  analyzedAt: z.string(),
  headSha: z.string(),
  defaultBranch: z.string(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  topics: z.array(z.string()),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  license: z.string().optional(),
  archived: z.boolean(),
  isFork: z.boolean(),
  nature: RepoNature,
  natureReason: z.string(),
  languages: z.array(Language),
  ecosystems: z.array(Ecosystem),
  ci: CiInfo,
  structure: Structure,
  activity: Activity,
  welcomeness: Welcomeness,
  conventions: Conventions,
  hotFiles: z.array(HotFile),
  /** Instruction files for contributors and coding agents: CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions.md. */
  instructionFiles: z.array(z.string()),
  /** Plain-language observations that did not fit a field. */
  notes: z.array(z.string()),
});
export type RepositoryProfile = z.infer<typeof RepositoryProfile>;

export const SkippedFinding = z.object({
  kind: OpportunityKind,
  title: z.string(),
  reason: z.string(),
});
export type SkippedFinding = z.infer<typeof SkippedFinding>;

export const Budget = z.object({
  apiRequests: z.number().int().nonnegative(),
  httpChecks: z.number().int().nonnegative(),
  cloneMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  /** Some analysis was cut short to stay within limits. */
  truncated: z.boolean(),
  notes: z.array(z.string()),
});
export type Budget = z.infer<typeof Budget>;

/** Optional context from discovery about why this repository was selected. */
export const AnalysisHints = z
  .object({
    goal: z.string().optional(),
    score: z.number().min(0).max(1).optional(),
    reasons: z
      .array(z.object({ signal: z.string(), weight: z.number(), detail: z.string() }))
      .optional(),
    /** Raw issue candidates discovery saw. Intel validates them; it does not trust them. */
    issues: z
      .array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          url: z.string(),
          labels: z.array(z.string()),
          createdAt: z.string(),
        }),
      )
      .optional(),
  })
  .loose();
export type AnalysisHints = z.infer<typeof AnalysisHints>;

export const AnalysisReport = z.object({
  /** Schema version of this report. */
  version: z.literal("1"),
  profile: RepositoryProfile,
  /** Ranked best first. */
  opportunities: z.array(ContributionOpportunity),
  /** Findings that were dropped, and why, so the ranking can be audited. */
  skipped: z.array(SkippedFinding),
  budget: Budget,
});
export type AnalysisReport = z.infer<typeof AnalysisReport>;
