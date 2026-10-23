import { join } from "node:path";
import type { DiscoveryQuery, DiscoveryResult, Goal, RepoRef } from "@gitgoblin/core";
import { createDiscovery } from "@gitgoblin/discovery";
import { type AnalysisOptions, type AnalysisReport, analyzeRepository } from "@gitgoblin/intel";
import { defaultCacheDir } from "@gitgoblin/sources";

/** One discovery session: a shared HTTP client and cache, closed when the call ends. */
export interface DiscoverySession {
  discover(query: DiscoveryQuery): Promise<DiscoveryResult[]>;
  explain(ref: RepoRef, goal: Goal): Promise<DiscoveryResult | undefined>;
  close(): void;
}

export type AnalyzeOptions = Pick<AnalysisOptions, "maxOpportunities" | "checkLinks" | "dependencyChecks" | "hints" | "log">;

/**
 * Clones made by the server live apart from the command line's, so every one of them was checked out
 * with the hardened git settings in safety.ts; an older clone could still hold a real symlink.
 */
export function mcpCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCacheDir(env), "mcp");
}

/** What the server needs from the rest of gitgoblin. Tests inject fakes. */
export interface ServerDeps {
  openDiscovery(onProgress: (message: string) => void): Promise<DiscoverySession>;
  analyze(ref: RepoRef, options: AnalyzeOptions): Promise<AnalysisReport>;
  now?: (() => number) | undefined;
}

/** Wires the real discovery engine and intel. Tokens and caches resolve exactly as in the command line. */
export function defaultDeps(): ServerDeps {
  return {
    async openDiscovery(onProgress) {
      const { engine, sources } = await createDiscovery({ onProgress: (event) => onProgress(`${event.stage}: ${event.message}`) });
      return {
        discover: (query) => engine.discover(query),
        explain: (ref, goal) => engine.explain(ref, goal),
        close: () => sources.close(),
      };
    },
    analyze: (ref, options) => analyzeRepository(ref, { ...options, cacheDir: mcpCacheDir() }),
  };
}
