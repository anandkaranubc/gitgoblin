import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DiscoveryQuery, DiscoveryResult, Goal, RepoRef } from "@gitgoblin/core";
import { createDiscovery } from "@gitgoblin/discovery";
import { type AnalysisOptions, type AnalysisReport, analyzeRepository, cloneDirFor } from "@gitgoblin/intel";
import { defaultCacheDir, resolveGitHubToken } from "@gitgoblin/sources";
import type { AnalyzeTask } from "./child.ts";
import { runInChild, Semaphore } from "./isolate.ts";
import { createPublicChecker, type Visibility } from "./public.ts";
import { ANALYSIS_HOSTS } from "./safety.ts";

/** One discovery session: a shared HTTP client and cache, closed when the call ends. */
export interface DiscoverySession {
  discover(query: DiscoveryQuery): Promise<DiscoveryResult[]>;
  explain(ref: RepoRef, goal: Goal): Promise<DiscoveryResult | undefined>;
  close(): void;
}

export type AnalyzeOptions = Pick<AnalysisOptions, "maxOpportunities" | "checkLinks" | "dependencyChecks" | "hints" | "log" | "cloneTimeoutMs"> & {
  /** The client cancelled; stop the analysis. */
  signal?: AbortSignal | undefined;
};

/** An analysis that runs longer than this is stopped. A normal one takes seconds to a minute. */
export const ANALYSIS_TIMEOUT_MS = 5 * 60_000;
/** Analyses that run at once; the rest wait. Each clones a repository and can use a CPU core. */
export const MAX_CONCURRENT_ANALYSES = 2;
/** Clones kept per forge; the least recently used beyond this are deleted. */
export const MAX_CLONES_PER_HOST = 20;
/** Cloning gives up before the analysis limit, so a slow clone fails cleanly instead of being killed mid-write. */
export const CLONE_TIMEOUT_MS = 4 * 60_000;
/** Heap limit for an analysis child, in megabytes. */
export const ANALYSIS_HEAP_MB = 2048;

/**
 * Where the server keeps its clones, apart from the command line's. Intel keys each clone by forge as
 * well as owner and name (repos/<host>/<owner>/<name>), so an attacker's codeberg.org/<owner>/<name>
 * can never stand in for github.com/<owner>/<name>.
 */
export function mcpCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCacheDir(env), "mcp");
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

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

const lockFor = (clone: string) => `${clone}.lock`;

/** True when the process named in a clone lock is gone, so the lock can be taken over. */
function lockAbandoned(lock: string): boolean {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    // An empty file is a lock its holder has not written its pid into yet.
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - statSync(lock).mtimeMs > 10_000;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM"; // EPERM: alive, someone else's
  }
}

/**
 * Runs `task` holding `<clone>.lock`, a file with the holder's pid, so two analyses of one repository,
 * in this server or in another one sharing the cache, never clone into or reset the same directory at
 * once. A lock whose process is gone is taken over.
 */
export async function withCloneLock<T>(clone: string, task: () => Promise<T>, signal?: AbortSignal, pollMs = 250): Promise<T> {
  const lock = lockFor(clone);
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lockAbandoned(lock)) {
      rmSync(lock, { force: true });
      continue;
    }
    if (signal?.aborted) throw new Error("cancelled by the client");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await task();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Deletes one forge's least recently used clones (`root/repos/<host>/<owner>/<name>`) beyond `keep`, never one an analysis holds. */
export function pruneClones(root: string, host: string, keep: number): string[] {
  const forge = join(root, "repos", host.toLowerCase());
  const entries = subdirectories(forge)
    .flatMap((owner) => subdirectories(owner))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }));
  const removed: string[] = [];
  for (const entry of entries.sort((a, b) => b.mtime - a.mtime).slice(keep)) {
    if (existsSync(lockFor(entry.path))) continue;
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return removed;
}

/**
 * Deletes clones left by earlier versions of the server: `repos/<owner>__<name>` (before clones were
 * keyed by forge) and `<host>/` (0.1.7's first layout). Their checkouts were made with weaker settings,
 * and nothing reads them any more.
 */
export function removeLegacyClones(root: string, hosts: readonly string[]): string[] {
  const removed: string[] = [];
  for (const path of subdirectories(join(root, "repos"))) {
    if (!basename(path).includes("__")) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  for (const host of hosts) {
    const path = join(root, host);
    if (subdirectories(root).includes(path)) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
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
  let home: string | undefined;
  let tidied = false;
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
    analyze: (ref, options) => {
      const cacheDir = mcpCacheDir();
      // The lock is taken outside the gate, so an analysis waiting for the same repository holds no slot.
      return withCloneLock(
        cloneDirFor(cacheDir, ref),
        () =>
          gate.run(async () => {
            const { log, signal, ...rest } = options;
            if (!childEntry) return analyzeRepository(ref, { ...rest, log, cacheDir, cloneTimeoutMs: CLONE_TIMEOUT_MS });
            if (!tidied) {
              tidied = true;
              removeLegacyClones(cacheDir, ANALYSIS_HOSTS);
            }
            home ??= mkdtempSync(join(tmpdir(), "gitgoblin-mcp-home-"));
            mkdirSync(join(home, ".config"), { recursive: true });
            token ??= resolveGitHubToken().catch(() => undefined);
            try {
              const task: AnalyzeTask = { kind: "analyze", ref, options: { ...rest, cloneTimeoutMs: CLONE_TIMEOUT_MS }, cacheDir };
              return await runInChild<AnalysisReport>(childEntry, task, {
                timeoutMs: ANALYSIS_TIMEOUT_MS,
                signal,
                onLog: log,
                env: analysisEnv(process.env, home, await token),
                maxOldSpaceMb: ANALYSIS_HEAP_MB,
                label: `Analysis of ${ref.owner}/${ref.name}`,
              });
            } finally {
              pruneClones(cacheDir, ref.host, MAX_CLONES_PER_HOST);
            }
          }),
        options.signal,
      );
    },
  };
}
