import { join } from "node:path";

import { ANALYZERS } from "./analyzers/index.ts";
import type { Finding } from "./analyzers/types.ts";
import { type AnalysisContext, type AnalysisOptions, BudgetTracker, resolveOptions } from "./context.ts";
import { AnalysisReport, type ContributionOpportunity, RepoRef, type RepoRefInput, type RepositoryProfile } from "./contracts.ts";
import { evaluate } from "./evaluate/index.ts";
import { scanRepo } from "./fs/scan.ts";
import { ensureClone, openRepo } from "./git/repo.ts";
import { FetchGitHubApi, type GitHubApi, discoverToken } from "./github/client.ts";
import { sharedGitHubApi } from "./github/sources-adapter.ts";
import { fetchLanguages, fetchReleases, fetchRepoMeta, fetchSamples, fetchWorkflowRuns } from "./github/fetch.ts";
import type { GitHubSamples, Release, WorkflowRun } from "./github/types.ts";
import { detectManifests } from "./manifests/index.ts";
import { buildProfile } from "./profile/index.ts";
import { earlyClosedReason } from "./profile/welcomeness.ts";
import { DiskCache, defaultCacheDir } from "./util/cache.ts";
import { isoDaysBefore } from "./util/time.ts";

export * from "./contracts.ts";
export type { AnalysisOptions } from "./context.ts";
export type { GitHubApi } from "./github/client.ts";
export { renderMarkdown } from "./report/markdown.ts";

/** Accepts "owner/name", a GitHub URL, or a RepoRef. */
export function parseRepoRef(input: string | RepoRefInput): RepoRef {
  if (typeof input !== "string") return RepoRef.parse(input);
  const url = /^(?:https?:\/\/)?(?:www\.)?([\w.-]+\.\w+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(input.trim());
  if (url) return RepoRef.parse({ host: url[1], owner: url[2], name: url[3] });
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(input.trim());
  if (short) return RepoRef.parse({ owner: short[1], name: short[2] });
  throw new Error(`Cannot parse repository reference: ${input}`);
}

/** Understand a repository and rank what an outsider could contribute. */
export async function analyzeRepository(input: string | RepoRefInput, options: AnalysisOptions = {}): Promise<AnalysisReport> {
  const ref = parseRepoRef(input);
  const opts = resolveOptions(options, defaultCacheDir());
  const log = opts.log;
  // Prefer the shared client from @gitgoblin/sources (one cache and rate-limit budget for all packages).
  const shared = opts.github ? undefined : await sharedGitHubApi();
  const github: GitHubApi = opts.github ?? shared ?? new FetchGitHubApi({ token: await discoverToken(), cache: new DiskCache(join(opts.cacheDir, "api")), cacheTtlMs: opts.cacheTtlMs });
  log(shared ? "using the shared GitHub client from @gitgoblin/sources" : opts.github ? "using the injected GitHub client" : "using the built-in GitHub client");
  try {
    return await run(ref, github, opts);
  } finally {
    shared?.close();
  }
}

async function run(ref: RepoRef, github: GitHubApi, opts: ReturnType<typeof resolveOptions>): Promise<AnalysisReport> {
  const log = opts.log;
  const budget = new BudgetTracker(github);
  const now = opts.now;

  log(`fetching metadata for ${ref.owner}/${ref.name}`);
  const meta = await fetchRepoMeta(github, ref.owner, ref.name);

  let repo;
  if (ref.localPath) {
    repo = openRepo(ref.localPath);
  } else {
    log(`cloning (blob:none)${meta.sizeKb > 300_000 ? ", shallow history" : ""}`);
    const clone = await ensureClone(ref, { cacheDir: opts.cacheDir, depth: meta.sizeKb > 300_000 ? 2000 : undefined });
    repo = clone.repo;
    budget.cloneMs = clone.cloneMs;
    if (meta.sizeKb > 300_000) budget.note("history limited to 2000 commits because the repository is large");
  }
  if (!(await repo.headSha().catch(() => undefined))) throw new EmptyRepositoryError(`${ref.owner}/${ref.name} has no commits; nothing to analyze`);

  log("inventorying files and history");
  const [inventory, commits, languages, releases] = await Promise.all([
    scanRepo(repo),
    repo.log({ since: isoDaysBefore(now, 365), maxCount: 5000 }),
    fetchLanguages(github, ref.owner, ref.name).catch(() => ({}) as Record<string, number>),
    fetchReleases(github, ref.owner, ref.name).catch((): Release[] => []),
  ]);
  if (commits.length >= 5000) budget.cut("commit history capped at 5000 for the last year");

  let samples: GitHubSamples | undefined;
  const readmePath = inventory.files.find((f) => /^readme(\.\w+)?$/i.test(f.path))?.path;
  const contributingPath = inventory.files.find((f) => /^(\.github\/|docs?\/)?contributing(\.\w+)?$/i.test(f.path))?.path;
  const closedEarly = earlyClosedReason(meta, readmePath ? await repo.readText(readmePath) : undefined, contributingPath ? await repo.readText(contributingPath) : undefined);
  if (closedEarly) {
    budget.note(`issue and PR sampling skipped: ${closedEarly}`);
  } else {
    try {
      log("sampling issues and pull requests");
      samples = await fetchSamples(github, ref.owner, ref.name);
    } catch (error) {
      budget.note(`issue and PR samples unavailable: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  let runs: WorkflowRun[] = [];
  if (inventory.files.some((f) => f.path.startsWith(".github/workflows/"))) {
    runs = await fetchWorkflowRuns(github, ref.owner, ref.name, meta.defaultBranch).catch((error: Error) => {
      budget.note(`workflow runs unavailable: ${error.message.split("\n")[0]}`);
      return [];
    });
  }
  const manifests = await detectManifests(inventory, (p) => repo.readText(p));

  const ctx: AnalysisContext = {
    ref, repo, inventory, meta, languages, samples, releases, runs, manifests, commits, now,
    nowIso: now.toISOString(), budget, options: opts, github,
    read: (path, maxBytes) => repo.readText(path, maxBytes),
    log,
  };

  log("building profile");
  const profile: RepositoryProfile = await buildProfile(ctx);

  const findings: Finding[] = [];
  // Nothing can be contributed to a closed repository; skip the expensive part and say so.
  const analyzers = profile.archived || profile.welcomeness.level === "closed" ? [] : ANALYZERS;
  if (analyzers.length === 0) budget.note(`analyzers skipped: ${profile.welcomeness.signals[0]?.signal ?? "repository is closed to contributions"}`);
  for (const analyzer of analyzers) {
    try {
      log(`running ${analyzer.name}`);
      findings.push(...(await analyzer.run(ctx, profile)));
    } catch (error) {
      budget.note(`${analyzer.name} failed: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  const { opportunities, skipped } = evaluate(findings, profile, opts.maxOpportunities);
  const report: AnalysisReport = { version: "1", profile, opportunities, skipped, budget: budget.toBudget() };
  return AnalysisReport.parse(report);
}

/** The clone succeeded but HEAD has no commits. */
export class EmptyRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyRepositoryError";
  }
}

export type { ContributionOpportunity };
