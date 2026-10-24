import { join } from "node:path";

import { ANALYZERS } from "./analyzers/index.ts";
import type { Finding } from "./analyzers/types.ts";
import { type AnalysisContext, type AnalysisOptions, BudgetTracker, resolveOptions } from "./context.ts";
import { AnalysisReport, type ContributionOpportunity, RepoRef, type RepoRefInput, type RepositoryProfile } from "./contracts.ts";
import { evaluate } from "./evaluate/index.ts";
import { scanRepo } from "./fs/scan.ts";
import { ensureClone, openRepo, looksLikeSha } from "./git/repo.ts";
export { cloneDirFor } from "./git/repo.ts";
export { PrivateRepositoryError } from "./github/fetch.ts";
import { FetchGitHubApi, type GitHubApi, GitHubError, discoverToken } from "./github/client.ts";
import { sharedGitHubApi } from "./github/sources-adapter.ts";
import { detectForge, fetchForge } from "./forge/index.ts";
import { type LlmClient, createAnthropicLlm } from "./llm/client.ts";
import { fetchLanguages, fetchReleases, fetchRepoMeta, fetchSamples, fetchWorkflowRuns } from "./github/fetch.ts";
import type { FailedJob, GitHubSamples, Release, RepoMeta, WorkflowRun } from "./github/types.ts";
import type { FileInventory } from "./fs/scan.ts";
import type { GitRepo } from "./git/repo.ts";
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
    return await run(ref, github, opts, options);
  } finally {
    shared?.close();
  }
}

async function run(ref: RepoRef, github: GitHubApi, opts: ReturnType<typeof resolveOptions>, options: AnalysisOptions): Promise<AnalysisReport> {
  const log = opts.log;
  const onGitHub = ref.host === "github.com";
  const budget = new BudgetTracker(onGitHub ? github : undefined);

  // Other forges: GitLab and Gitea/Forgejo expose public APIs for issues and merge requests; anything else gets the clone alone.
  let meta: RepoMeta | undefined;
  let forgeSamples: GitHubSamples | undefined;
  let forgeRuns: WorkflowRun[] = [];
  let failedJobs: ((runId: number) => Promise<FailedJob[]>) | undefined;
  if (onGitHub) {
    log(`fetching metadata for ${ref.owner}/${ref.name}`);
    meta = await fetchRepoMeta(github, ref.owner, ref.name).catch((error: unknown) => {
      // 404 for a private repository too: GitHub does not say which, and neither can we.
      if (error instanceof GitHubError && error.status === 404) throw new RepositoryNotFoundError(ref);
      throw error;
    });
  } else {
    const forgeOptions = { fetchImpl: opts.fetchImpl ?? fetch, cache: new DiskCache(join(opts.cacheDir, "forge")), cacheTtlMs: opts.cacheTtlMs };
    const kind = opts.skipSamples ? undefined : await detectForge(ref.host, forgeOptions);
    if (opts.skipSamples) budget.note(`${ref.host}: forge API not queried (samples skipped by request); analysis uses the clone only`);
    else if (kind) {
      try {
        log(`fetching issues and merge requests from the ${kind} API on ${ref.host}`);
        const result = await fetchForge(kind, ref.host, ref.owner, ref.name, forgeOptions);
        meta = result.meta;
        forgeSamples = result.samples;
        forgeRuns = result.runs ?? [];
        failedJobs = result.failedJobs;
        budget.forgeRequests += result.requests;
        for (const note of result.notes ?? []) budget.note(note);
        budget.note(`${ref.host} (${kind}): issues and merge requests sampled without authentication; maintainer status inferred from who merges and closes${forgeRuns.length ? `; ${forgeRuns.length} recent pipelines read` : "; CI runs not read"}`);
      } catch (error) {
        budget.note(`${ref.host} (${kind}) API unavailable: ${(error as Error).message.split("\n")[0]}; analysis uses the clone only`);
      }
    } else {
      budget.note(`${ref.host} is not GitHub, GitLab or Gitea: issues, pull requests, CI runs and stars are unavailable; analysis uses the clone only`);
    }
  }

  let repo;
  if (ref.localPath) {
    repo = openRepo(ref.localPath);
  } else {
    const large = (meta?.sizeKb ?? 0) > 300_000;
    log(`cloning (blob:none)${large ? ", shallow history" : ""}`);
    const clone = await ensureClone(ref, { cacheDir: opts.cacheDir, depth: large ? 2000 : undefined, timeoutMs: options.cloneTimeoutMs }).catch((error: unknown) => {
      // Other forges have no metadata call to fail first; git's own message is the signal.
      if (/repository '[^']*' not found|not found|could not read Username|Authentication failed/i.test((error as Error).message ?? "")) throw new RepositoryNotFoundError(ref);
      throw error;
    });
    repo = clone.repo;
    budget.cloneMs = clone.cloneMs;
    if (large) budget.note("history limited to 2000 commits because the repository is large");
  }
  if (!(await repo.headSha().catch(() => undefined))) throw new EmptyRepositoryError(`${ref.owner}/${ref.name} has no commits; nothing to analyze`);
  meta ??= await metaFromGit(ref, repo);

  // Analyzing a past commit: unless the caller fixed the clock, ages are relative to that commit's date.
  if (ref.ref && looksLikeSha(ref.ref) && options.now === undefined) {
    const head = await repo.log({ maxCount: 1 });
    if (head[0]) {
      opts.now = new Date(head[0].date);
      budget.note(`clock set to the analyzed commit (${head[0].date.slice(0, 10)}); issue, PR and CI samples are live, not historical`);
    }
  }
  const now = opts.now;

  log("inventorying files and history");
  const [inventory, commits, apiLanguages, apiReleases] = await Promise.all([
    scanRepo(repo),
    repo.log({ since: isoDaysBefore(now, 365), maxCount: 5000 }),
    onGitHub ? fetchLanguages(github, ref.owner, ref.name).catch(() => ({}) as Record<string, number>) : Promise.resolve({} as Record<string, number>),
    onGitHub ? fetchReleases(github, ref.owner, ref.name).catch((): Release[] => []) : Promise.resolve([] as Release[]),
  ]);
  if (commits.length >= 5000) budget.cut("commit history capped at 5000 for the last year");
  const languages = Object.keys(apiLanguages).length ? apiLanguages : languagesFromInventory(inventory);
  const releases = apiReleases.length ? apiReleases : (await repo.tags()).map((t) => ({ tagName: t.name, publishedAt: t.date, prerelease: /alpha|beta|rc|dev|pre/i.test(t.name) }));

  let samples: GitHubSamples | undefined = forgeSamples;
  const readmePath = inventory.files.find((f) => /^readme(\.\w+)?$/i.test(f.path))?.path;
  const contributingPath = inventory.files.find((f) => /^(\.github\/|docs?\/)?contributing(\.\w+)?$/i.test(f.path))?.path;
  const closedEarly = earlyClosedReason(meta, readmePath ? await repo.readText(readmePath) : undefined, contributingPath ? await repo.readText(contributingPath) : undefined);
  if (closedEarly) {
    budget.note(`issue and PR sampling skipped: ${closedEarly}`);
    samples = undefined;
  } else if (opts.skipSamples) {
    budget.note("issue, PR and CI sampling skipped by request; clone-based analysis only");
    samples = undefined;
  } else if (onGitHub) {
    try {
      log("sampling issues and pull requests");
      samples = await fetchSamples(github, ref.owner, ref.name);
    } catch (error) {
      // A cut, not a note: the report is missing most of what it would otherwise contain, and says so.
      budget.cut(`issue and PR samples unavailable: ${(error as Error).message.split("\n")[0]}; issues and pull requests were not analyzed, try again in a minute`);
    }
  }
  let runs: WorkflowRun[] = opts.skipSamples ? [] : forgeRuns;
  if (onGitHub && !opts.skipSamples && inventory.files.some((f) => f.path.startsWith(".github/workflows/"))) {
    runs = await fetchWorkflowRuns(github, ref.owner, ref.name, meta.defaultBranch).catch((error: Error) => {
      budget.note(`workflow runs unavailable: ${error.message.split("\n")[0]}`);
      return [];
    });
  }
  const manifests = await detectManifests(inventory, (p) => repo.readText(p));
  const llm = resolveLlm(opts.llm);
  if (llm) log(`language-model review enabled (${llm.model})`);

  const ctx: AnalysisContext = {
    ref, repo, inventory, meta, languages, samples, releases, runs, failedJobs, manifests, commits, now,
    nowIso: now.toISOString(), budget, options: opts, github: onGitHub ? github : undefined, llm,
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

  if (llm && llm.usage.calls > 0) budget.note(`llm: ${llm.usage.calls} calls, ${llm.usage.inputTokens} input and ${llm.usage.outputTokens} output tokens (${llm.model})`);
  const { opportunities, skipped } = evaluate(findings, profile, opts.maxOpportunities, opts.noKindCaps ? {} : undefined);
  const report: AnalysisReport = { version: "1", profile, opportunities, skipped, budget: budget.toBudget() };
  return AnalysisReport.parse(report);
}

/** No public repository at that address (it does not exist, is private, or was renamed without a redirect). */
export class RepositoryNotFoundError extends Error {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  constructor(ref: Pick<RepoRef, "host" | "owner" | "name">) {
    super(`${ref.owner}/${ref.name} was not found on ${ref.host}`);
    this.name = "RepositoryNotFoundError";
    this.host = ref.host;
    this.owner = ref.owner;
    this.repo = ref.name;
  }
}

/** The clone succeeded but HEAD has no commits. */
export class EmptyRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyRepositoryError";
  }
}

/** Metadata for repositories that are not on GitHub, from the clone alone. */
async function metaFromGit(ref: RepoRef, repo: GitRepo): Promise<RepoMeta> {
  const [defaultBranch, head, first] = await Promise.all([repo.defaultBranch(), repo.log({ maxCount: 1 }), repo.firstCommitDate()]);
  const latest = head[0]?.date ?? new Date().toISOString();
  return {
    owner: ref.owner, name: ref.name, defaultBranch, description: undefined, homepage: undefined, topics: [],
    stars: 0, forks: 0, watchers: 0, openIssuesAndPrs: 0, license: undefined, archived: false, disabled: false,
    isFork: false, isTemplate: false, hasIssues: false, sizeKb: 0, createdAt: first ?? latest, pushedAt: latest,
  };
}

/** Bytes per language from the inventory, used when the GitHub languages call is unavailable. */
function languagesFromInventory(inventory: FileInventory): Record<string, number> {
  const bytes: Record<string, number> = {};
  let headerBytes = 0;
  for (const f of inventory.files) {
    if (f.vendored || !f.language || f.category === "docs" || f.category === "config") continue;
    if (f.ext === ".h") { headerBytes += f.sizeBytes; continue; }
    bytes[f.language] = (bytes[f.language] ?? 0) + f.sizeBytes;
  }
  // .h belongs to whichever of C and C++ the sources are written in.
  if (headerBytes) { const lang = (bytes["C++"] ?? 0) > (bytes.C ?? 0) ? "C++" : "C"; bytes[lang] = (bytes[lang] ?? 0) + headerBytes; }
  return bytes;
}

function resolveLlm(option: ReturnType<typeof resolveOptions>["llm"]): LlmClient | undefined {
  if (!option) return undefined;
  if (typeof option === "object" && "parse" in option) return option;
  return createAnthropicLlm(typeof option === "object" ? { model: option.model } : {});
}

export type { ContributionOpportunity };
export type { LlmClient } from "./llm/client.ts";
