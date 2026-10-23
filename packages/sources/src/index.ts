import { EcosystemsClient } from "./ecosystems/client.ts";
import { GitHubClient } from "./github/client.ts";
import { resolveGitHubToken } from "./github/token.ts";
import { defaultCachePath, type HttpCache, MemoryCache, SqliteCache } from "./http/cache.ts";
import { HttpClient, type HttpEvent } from "./http/client.ts";

export {
  type CacheEntry,
  type CacheStats,
  defaultCacheDir,
  defaultCachePath,
  type HttpCache,
  isFresh,
  MemoryCache,
  SqliteCache,
  type SqliteCacheOptions,
} from "./http/cache.ts";
export {
  HttpClient,
  type HttpClientOptions,
  HttpError,
  type HttpEvent,
  RateLimitError,
  type RateLimitState,
  type RequestOptions,
} from "./http/client.ts";
export {
  GitHubClient,
  type GitHubClientOptions,
  type GitHubRepoDetails,
  GraphQLError,
  MissingTokenError,
  type RestOptions,
  type SearchOptions,
  type SearchResult,
  STARTER_ISSUE_LABELS,
} from "./github/client.ts";
export { resolveGitHubToken } from "./github/token.ts";
export {
  EcosystemsClient,
  type EcosystemsClientOptions,
  type EcosystemsIssueStats,
  type EcosystemsPackage,
  type EcosystemsRepo,
} from "./ecosystems/client.ts";

export interface SourcesOptions {
  /** GitHub token. When omitted, resolveGitHubToken() is consulted. */
  token?: string | undefined;
  /** SQLite file for the cache, ":memory:" for none on disk. Defaults to defaultCachePath(). */
  cachePath?: string | undefined;
  cache?: HttpCache | undefined;
  fetch?: typeof fetch | undefined;
  onEvent?: ((event: HttpEvent) => void) | undefined;
  userAgent?: string | undefined;
}

export interface Sources {
  http: HttpClient;
  cache: HttpCache;
  github: GitHubClient;
  ecosystems: EcosystemsClient;
  close(): void;
}

/** The on-disk cache, or an in-memory one when the disk is not available (read-only home, broken file). */
function openCache(options: SourcesOptions): HttpCache {
  if (options.cache) return options.cache;
  if (options.cachePath === ":memory:") return new MemoryCache();
  const path = options.cachePath ?? defaultCachePath();
  try {
    return new SqliteCache(path);
  } catch (error) {
    options.onEvent?.({ type: "cache-fallback", path, error: error instanceof Error ? error.message : String(error) });
    return new MemoryCache();
  }
}

/** Wires one shared HTTP client, cache and token into ready-to-use API clients. */
export async function createSources(options: SourcesOptions = {}): Promise<Sources> {
  const cache = openCache(options);
  const http = new HttpClient({ cache, fetch: options.fetch, onEvent: options.onEvent, userAgent: options.userAgent });
  const token = options.token ?? (await resolveGitHubToken());
  return {
    http,
    cache,
    github: new GitHubClient(http, { token }),
    ecosystems: new EcosystemsClient(http),
    close: () => cache.close(),
  };
}
