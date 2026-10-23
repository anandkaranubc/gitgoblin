import type { AnalysisHints, Budget, RepoRef } from "./contracts.ts";
import type { FileInventory } from "./fs/scan.ts";
import type { Commit, GitRepo } from "./git/repo.ts";
import type { GitHubApi } from "./github/client.ts";
import type { FailedJob, GitHubSamples, Release, RepoMeta, WorkflowRun } from "./github/types.ts";
import type { LlmClient } from "./llm/client.ts";
import type { Manifests } from "./manifests/index.ts";

export interface AnalysisOptions {
  /** Inject a GitHub client (for tests, or the shared `@gitgoblin/sources` client). */
  github?: GitHubApi | undefined;
  cacheDir?: string | undefined;
  /** How long cached API responses stay valid. */
  cacheTtlMs?: number | undefined;
  /** Verify external links over HTTP. Default true. */
  checkLinks?: boolean | undefined;
  /** Query OSV and package registries about dependencies. Default true. */
  dependencyChecks?: boolean | undefined;
  /** Maximum opportunities in the report. Default 15. */
  maxOpportunities?: number | undefined;
  hints?: AnalysisHints | undefined;
  /** Clock, for reproducible tests. */
  now?: Date | undefined;
  log?: ((message: string) => void) | undefined;
  /** Override the fetch used for link checks and OSV. */
  fetchImpl?: typeof fetch | undefined;
  /**
   * Second opinion from a language model on issue triage. Off by default (it costs money).
   * `true` uses Claude via the Anthropic SDK; pass a model name, or an LlmClient for tests.
   */
  llm?: boolean | { model?: string | undefined } | LlmClient | undefined;
}

export interface ResolvedOptions {
  cacheDir: string;
  cacheTtlMs: number;
  checkLinks: boolean;
  dependencyChecks: boolean;
  maxOpportunities: number;
  now: Date;
  log: (message: string) => void;
  github: GitHubApi | undefined;
  hints: AnalysisHints | undefined;
  fetchImpl: typeof fetch | undefined;
  llm: AnalysisOptions["llm"];
}

export function resolveOptions(options: AnalysisOptions, cacheDir: string): ResolvedOptions {
  return {
    cacheDir: options.cacheDir ?? cacheDir,
    cacheTtlMs: options.cacheTtlMs ?? 3_600_000,
    checkLinks: options.checkLinks ?? true,
    dependencyChecks: options.dependencyChecks ?? true,
    maxOpportunities: options.maxOpportunities ?? 15,
    now: options.now ?? new Date(),
    log: options.log ?? (() => {}),
    github: options.github,
    hints: options.hints,
    fetchImpl: options.fetchImpl,
    llm: options.llm,
  };
}

/** Tracks what an analysis spent so the report can say when it cut corners. */
export class BudgetTracker {
  httpChecks = 0;
  /** Requests to a non-GitHub forge API. */
  forgeRequests = 0;
  cloneMs = 0;
  truncated = false;
  readonly notes: string[] = [];
  private readonly started = Date.now();
  private readonly api: GitHubApi | undefined;

  constructor(api: GitHubApi | undefined) {
    this.api = api;
  }

  cut(note: string): void {
    this.truncated = true;
    this.notes.push(note);
  }

  note(note: string): void {
    this.notes.push(note);
  }

  toBudget(): Budget {
    return {
      apiRequests: (this.api?.stats.requests ?? 0) + this.forgeRequests,
      httpChecks: this.httpChecks,
      cloneMs: this.cloneMs,
      totalMs: Date.now() - this.started,
      truncated: this.truncated,
      notes: [...this.notes],
    };
  }
}

/** Everything analyzers and profile builders can see. Built once per run. */
export interface AnalysisContext {
  ref: RepoRef;
  repo: GitRepo;
  inventory: FileInventory;
  meta: RepoMeta;
  languages: Record<string, number>;
  /** Undefined without a token or when GraphQL failed; analyzers that need it skip. */
  samples: GitHubSamples | undefined;
  releases: Release[];
  /** Recent completed runs on the default branch (push, schedule, dispatch), newest first. */
  runs: WorkflowRun[];
  /** Failed jobs of a run; set for forges whose API provides them (GitHub's is the default). */
  failedJobs: ((runId: number) => Promise<FailedJob[]>) | undefined;
  manifests: Manifests;
  /** Non-merge commits from the last 365 days, newest first (capped). */
  commits: Commit[];
  now: Date;
  nowIso: string;
  budget: BudgetTracker;
  options: ResolvedOptions;
  github: GitHubApi | undefined;
  /** Present only when the caller opted in. */
  llm: LlmClient | undefined;
  read(path: string, maxBytes?: number): Promise<string | undefined>;
  log(message: string): void;
}
