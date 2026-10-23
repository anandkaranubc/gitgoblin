import { type GitHubApi, GitHubError, type GitHubStats } from "./client.ts";

/** The slice of `@gitgoblin/sources` intel relies on, typed structurally so no build coupling exists. */
export interface SourcesLike {
  github: {
    rest<T>(path: string, options?: { params?: Record<string, string | number> }): Promise<T>;
    graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
    rateLimits(): Record<string, { remaining: number }>;
  };
  close(): void;
}

export interface SharedGitHubApi extends GitHubApi {
  close(): void;
}

/** Wrap a `@gitgoblin/sources` instance as the `GitHubApi` intel expects, translating its errors. */
export function adaptSources(sources: SourcesLike): SharedGitHubApi {
  // Counts calls through the adapter; the shared cache may answer some without a network request.
  const stats: GitHubStats = { requests: 0 };
  const noteLimits = () => {
    const limits = sources.github.rateLimits();
    const remaining = [limits.core?.remaining, limits.graphql?.remaining].filter((n): n is number => typeof n === "number");
    if (remaining.length) stats.remaining = Math.min(...remaining);
  };
  const translate = (error: unknown, path: string): never => {
    const e = error as { name?: string; status?: number; message?: string };
    if (e?.name === "HttpError" && typeof e.status === "number") throw new GitHubError(e.message ?? `HTTP ${e.status}`, e.status, path);
    if (e?.name === "GraphQLError" || e?.name === "MissingTokenError") throw new GitHubError(e.message ?? "GraphQL failed", 200, path);
    throw error;
  };
  return {
    stats,
    async rest<T>(path: string, params?: Record<string, string | number>): Promise<T> {
      stats.requests++;
      try {
        return await sources.github.rest<T>(path, params ? { params } : {});
      } catch (error) {
        return translate(error, path);
      } finally {
        noteLimits();
      }
    },
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      stats.requests++;
      try {
        return await sources.github.graphql<T>(query, variables ?? {});
      } catch (error) {
        return translate(error, "/graphql");
      } finally {
        noteLimits();
      }
    },
    close: () => sources.close(),
  };
}

/** The shared client when `@gitgoblin/sources` is installed alongside; undefined otherwise. */
export async function sharedGitHubApi(): Promise<SharedGitHubApi | undefined> {
  const specifier = "@gitgoblin/sources";
  try {
    const mod = (await import(specifier)) as { createSources?: (options?: object) => Promise<SourcesLike> };
    if (typeof mod.createSources !== "function") return undefined;
    return adaptSources(await mod.createSources({ userAgent: "gitgoblin-intel" }));
  } catch {
    return undefined;
  }
}
