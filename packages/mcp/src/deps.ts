import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryQuery, DiscoveryResult, Goal, RepoRef } from "@gitgoblin/core";
import { createDiscovery } from "@gitgoblin/discovery";
import { type AnalysisOptions, type AnalysisReport, analyzeRepository } from "@gitgoblin/intel";
import { defaultCacheDir, resolveGitHubToken } from "@gitgoblin/sources";
import type { AnalyzeTask } from "./child.ts";
import { runInChild, Semaphore } from "./isolate.ts";
import { createPublicChecker, type Visibility } from "./public.ts";

/** One discovery session: a shared HTTP client and cache, closed when the call ends. */
export interface DiscoverySession {
  discover(query: DiscoveryQuery): Promise<DiscoveryResult[]>;
  explain(ref: RepoRef, goal: Goal): Promise<DiscoveryResult | undefined>;
  close(): void;
}

export type AnalyzeOptions = Pick<AnalysisOptions, "maxOpportunities" | "checkLinks" | "dependencyChecks" | "hints" | "log"> & {
  /** The client cancelled; stop the analysis. */
  signal?: AbortSignal | undefined;
};

/** An analysis that runs longer than this is stopped. A normal one takes seconds to a minute. */
export const ANALYSIS_TIMEOUT_MS = 5 * 60_000;
/** Analyses that run at once; the rest wait. Each clones a repository and can use a CPU core. */
export const MAX_CONCURRENT_ANALYSES = 2;
/** Clones kept per forge; the least recently used beyond this are deleted. */
export const MAX_CLONES_PER_HOST = 20;
/** Heap limit for an analysis child, in megabytes. */
export const ANALYSIS_HEAP_MB = 2048;

/**
 * Where the server keeps its clones: apart from the command line's, and one directory per forge, so
 * an attacker's codeberg.org/<owner>/<name> can never stand in for github.com/<owner>/<name>.
 */
export function mcpCacheDir(host: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCacheDir(env), "mcp", host.toLowerCase());
}

/**
 * The analysis child's environment. Its home directory is an empty one, so git reads none of the
 * person's own configuration: no credential helper can serve a clone, no LFS filter runs on one, no
 * alias or hook applies. The GitHub token resolved here is passed explicitly, because the GitHub CLI
 * cannot find its login under the empty home; intel never hands it to git.
 */
export function analysisEnv(base: NodeJS.ProcessEnv, home: string, token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), GITGOBLIN_CACHE_DIR: defaultCacheDir(base) };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_")) delete env[key];
  delete env.GH_TOKEN;
  if (token) env.GITHUB_TOKEN = token;
  else delete env.GITHUB_TOKEN;
  return env;
}

/** Deletes the least recently used clones under `root/repos` beyond `keep`, never one in use. */
export function pruneClones(root: string, keep: number, inUse: ReadonlySet<string>): string[] {
  const dir = join(root, "repos");
  let entries: { path: string; mtime: number }[];
  try {
    entries = readdirSync(dir).map((name) => {
      const path = join(dir, name);
      return { path, mtime: statSync(path).mtimeMs };
    });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries.sort((a, b) => b.mtime - a.mtime).slice(keep)) {
    if (inUse.has(entry.path)) continue;
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return removed;
}

/** What the server needs from the rest of gitgoblin. Tests inject fakes. */
export interface ServerDeps {
  openDiscovery(onProgress: (message: string) => void): Promise<DiscoverySession>;
  analyze(ref: RepoRef, options: AnalyzeOptions): Promise<AnalysisReport>;
  /** Confirms, without credentials, that the repository is public. */
  isPublic(ref: RepoRef): Promise<Visibility>;
  now?: (() => number) | undefined;
}

/**
 * Wires the real discovery engine and intel. With `childEntry` (the server's own entry module), each
 * analysis runs in a child process that is killed, with everything it started, after
 * ANALYSIS_TIMEOUT_MS or when the client cancels; without it, analysis runs in this process.
 */
export function defaultDeps(childEntry?: string): ServerDeps {
  const gate = new Semaphore(MAX_CONCURRENT_ANALYSES);
  const inUse = new Set<string>();
  let home: string | undefined;
  let token: Promise<string | undefined> | undefined;
  return {
    async openDiscovery(onProgress) {
      const { engine, sources } = await createDiscovery({ onProgress: (event) => onProgress(`${event.stage}: ${event.message}`) });
      return {
        discover: (query) => engine.discover(query),
        explain: (ref, goal) => engine.explain(ref, goal),
        close: () => sources.close(),
      };
    },
    isPublic: createPublicChecker(),
    analyze: (ref, options) =>
      gate.run(async () => {
        const { log, signal, ...rest } = options;
        const cacheDir = mcpCacheDir(ref.host);
        if (!childEntry) return analyzeRepository(ref, { ...rest, log, cacheDir });
        home ??= mkdtempSync(join(tmpdir(), "gitgoblin-mcp-home-"));
        mkdirSync(join(home, ".config"), { recursive: true });
        token ??= resolveGitHubToken().catch(() => undefined);
        const clone = join(cacheDir, "repos", `${ref.owner}__${ref.name}`);
        inUse.add(clone);
        try {
          const task: AnalyzeTask = { kind: "analyze", ref, options: rest, cacheDir };
          return await runInChild<AnalysisReport>(childEntry, task, {
            timeoutMs: ANALYSIS_TIMEOUT_MS,
            signal,
            onLog: log,
            env: analysisEnv(process.env, home, await token),
            maxOldSpaceMb: ANALYSIS_HEAP_MB,
            label: `Analysis of ${ref.owner}/${ref.name}`,
          });
        } finally {
          inUse.delete(clone);
          pruneClones(cacheDir, MAX_CLONES_PER_HOST, inUse);
        }
      }),
  };
}
