import { z } from "zod";

/** Commands the repository uses. Discovered by repository intelligence, confirmed during orientation. */
export const CommandsSchema = z.object({
  install: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  format: z.string().optional(),
});
export type Commands = z.infer<typeof CommandsSchema>;

export const IssueRefSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).default([]),
  /** Someone is already assigned or has an open pull request for it. */
  inFlight: z.boolean().default(false),
});
export type IssueRef = z.infer<typeof IssueRefSchema>;

/**
 * Repository fields end up as git arguments and URL parts, so they are shaped here: an owner or name
 * cannot be a path, a sha cannot be an option, a branch cannot be a revision expression, and a clone
 * URL cannot select a transport such as `ext::` that runs commands.
 */
const Identifier = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$|^[A-Za-z0-9]$/, "letters, digits, dots, dashes and underscores only").refine((v) => v !== "..", "cannot be ..");
const Hostname = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/, "must be a hostname");
const Sha = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "must be a hex commit id");
const BranchName = z
  .string()
  .min(1)
  .refine((v) => !v.startsWith("-") && !/[\s~^:?*\[\\]/.test(v) && !v.includes("..") && !v.endsWith("/") && !v.endsWith(".lock"), "must be a plain branch name");
const CloneUrl = z.string().refine((v) => /^(https?|ssh|git|git\+ssh|file):\/\/[^\s]+$/.test(v) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(v), "must be an http(s), ssh, git or file URL");

/** Everything the engine needs to work on one contribution. Built by `intake.ts` from intel's contracts. */
export const TaskSchema = z.object({
  id: z.string().min(1),
  repo: z.object({
    host: Hostname.default("github.com"),
    owner: Identifier,
    name: Identifier,
    cloneUrl: CloneUrl.optional(),
    /** Existing local checkout. The engine creates a git worktree from it instead of cloning. */
    localPath: z.string().min(1).optional(),
    defaultBranch: BranchName.default("main"),
    headSha: Sha.optional(),
  }),
  commands: CommandsSchema.prefault({}),
  conventions: z
    .object({
      commitStyle: z.string().optional(),
      branchNaming: z.string().optional(),
      recentCommitSubjects: z.array(z.string()).default([]),
      testFramework: z.string().optional(),
      formatter: z.string().optional(),
    })
    .prefault({}),
  rules: z
    .object({
      contributingPath: z.string().optional(),
      prTemplatePath: z.string().optional(),
      instructionFiles: z.array(z.string()).default([]),
      /** Kinds of change the maintainers say they do not want, in their words. */
      rejectedChanges: z.array(z.string()).default([]),
      requiresIssueFirst: z.boolean().optional(),
      requiresTests: z.boolean().optional(),
      requiresChangelog: z.boolean().optional(),
      cla: z.boolean().optional(),
      dco: z.boolean().optional(),
    })
    .prefault({}),
  kind: z.string().default("issue"),
  title: z.string().min(1),
  summary: z.string().default(""),
  issue: IssueRefSchema.optional(),
  files: z.array(z.string()).default([]),
  approach: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  etiquette: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  effort: z.enum(["trivial", "small", "medium", "large"]).optional(),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;

// Phase artifacts produced by the model. Each schema doubles as the structured-output contract.

export const InvestigationSchema = z.object({
  summary: z.string(),
  relevantFiles: z.array(z.string()),
  rootCause: z.string(),
  reproduction: z.object({
    kind: z.enum(["test", "script", "manual", "none"]),
    path: z.string(),
    command: z.string(),
    observed: z.string(),
  }),
  commands: CommandsSchema,
  feasibility: z.enum(["proceed", "needs_human", "stop"]),
  reasons: z.array(z.string()),
  questions: z.array(z.string()),
});
export type Investigation = z.infer<typeof InvestigationSchema>;

export const ChangePlanSchema = z.object({
  goal: z.string(),
  steps: z.array(z.string()),
  filesToModify: z.array(z.string()),
  filesToCreate: z.array(z.string()),
  testsToAdd: z.array(z.string()),
  outOfScope: z.array(z.string()),
  risks: z.array(z.string()),
  needsNewDependency: z.boolean(),
  /** The commit subject the planner proposes: imperative, at most 72 characters, no issue number. */
  commitSubject: z.string().optional(),
});
export type ChangePlan = z.infer<typeof ChangePlanSchema>;

export const ImplementationNotesSchema = z.object({
  summary: z.string(),
  /** Read by the maintainers in the pull request. */
  deviationsFromPlan: z.array(z.string()),
  testsRun: z.array(z.string()),
  /** Read by the maintainers in the pull request. */
  knownGaps: z.array(z.string()),
  /** Problems with the agent's own tools or environment; shown to the operator, never to the maintainers. */
  environmentNotes: z.array(z.string()).optional(),
  done: z.boolean(),
});
export type ImplementationNotes = z.infer<typeof ImplementationNotesSchema>;

export const REVIEW_CHECKS = ["correctness", "scope", "tests", "conventions", "safety"] as const;

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "revise", "reject"]),
  checks: z.array(
    z.object({
      name: z.enum(REVIEW_CHECKS),
      verdict: z.enum(["pass", "fail", "unsure"]),
      evidence: z.string(),
    }),
  ),
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor", "nit"]),
      file: z.string(),
      line: z.number().int().nullable(),
      summary: z.string(),
      failureScenario: z.string(),
      suggestion: z.string(),
    }),
  ),
  prNotes: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

// Artifacts produced by the engine itself.

export type CheckStatus = "pass" | "fail" | "skipped" | "timeout";

export interface Check {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
  changedFiles: string[];
}

export interface Verification {
  checks: Check[];
  /** Names of checks that passed at baseline and fail now. */
  regressions: string[];
  /** True when nothing regressed and the reproduction (if any) passes. */
  ok: boolean;
  diff: DiffStats;
  /** Names of checks that already failed at baseline, so a reader does not blame the change for them. */
  preexisting?: string[];
}

/** What `prepare` wrote and `publish` reads back; validated on the way back in because the file sat on disk. */
export const PreparedDeliverySchema = z.object({
  branch: BranchName,
  commitSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/, "must be a full commit id"),
  commitMessage: z.string().min(1),
  prTitle: z.string().min(1).max(256),
  prBody: z.string(),
});
export type PreparedDelivery = z.infer<typeof PreparedDeliverySchema>;

export type RunStatus = "awaiting_approval" | "published" | "escalated" | "stopped" | "failed";

export interface RunResult {
  runId: string;
  runDir: string;
  status: RunStatus;
  reason: string;
  questions: string[];
  workspace: string | undefined;
  branch: string | undefined;
  costUsd: number;
  durationMs: number;
}
