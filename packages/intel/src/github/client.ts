import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiskCache } from "../util/cache.ts";
import { type FetchLike, defaultFetch, fetchWithTimeout, retry } from "../util/http.ts";

const execFileAsync = promisify(execFile);

/**
 * The slice of GitHub intel needs. `@gitgoblin/sources` can satisfy this
 * interface through an adapter so all packages share one rate-limit budget.
 */
export interface GitHubApi {
  /** GET a REST path such as `/repos/o/n`. Throws `GitHubError` on non-2xx. */
  rest<T>(path: string, params?: Record<string, string | number>): Promise<T>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  readonly stats: GitHubStats;
}

export interface GitHubStats {
  /** Requests that actually went to the network (cache hits excluded). */
  requests: number;
  /** Last seen `x-ratelimit-remaining`, if any. */
  remaining?: number;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.path = path;
  }
}

export class RateLimitError extends GitHubError {
  constructor(path: string, remaining: number) {
    super(`GitHub rate limit nearly exhausted (${remaining} left); stopping API use`, 429, path);
    this.name = "RateLimitError";
  }
}

/** Token from the environment or the `gh` CLI; undefined when neither has one. */
export async function discoverToken(): Promise<string | undefined> {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 5000 });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface FetchGitHubApiOptions {
  token?: string | undefined;
  cache?: DiskCache | undefined;
  /** How long cached responses stay valid. Default one hour. */
  cacheTtlMs?: number;
  /** Stop issuing requests when the remaining rate limit drops below this. */
  minRemaining?: number;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Minimal GitHub client: GET with caching, GraphQL, rate-limit awareness. */
export class FetchGitHubApi implements GitHubApi {
  readonly stats: GitHubStats = { requests: 0 };
  private readonly token: string | undefined;
  private readonly cache: DiskCache | undefined;
  private readonly cacheTtlMs: number;
  private readonly minRemaining: number;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: FetchGitHubApiOptions = {}) {
    this.token = options.token;
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? 3_600_000;
    this.minRemaining = options.minRemaining ?? 30;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async rest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return this.request<T>(url.toString(), { method: "GET" }, `GET ${url}`);
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({ query, variables });
    const url = new URL("/graphql", this.baseUrl).toString();
    const payload = await this.request<{ data?: T; errors?: { message: string }[] }>(
      url,
      { method: "POST", body },
      `POST graphql ${body}`,
    );
    if (!payload.data) {
      const detail = payload.errors?.map((e) => e.message).join("; ") ?? "no data";
      throw new GitHubError(`GraphQL failed: ${detail}`, 200, "/graphql");
    }
    return payload.data;
  }

  private async request<T>(url: string, init: RequestInit, cacheKey: string): Promise<T> {
    const cached = await this.cache?.get<T>(cacheKey, this.cacheTtlMs);
    if (cached !== undefined) return cached;

    if (this.stats.remaining !== undefined && this.stats.remaining < this.minRemaining) {
      throw new RateLimitError(url, this.stats.remaining);
    }

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "gitgoblin-intel",
      "x-github-api-version": "2022-11-28",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body) headers["content-type"] = "application/json";

    const response = await retry(
      () => fetchWithTimeout(this.fetchImpl, url, { ...init, headers }, this.timeoutMs),
      { attempts: 2, delayMs: 500 },
    );
    this.stats.requests++;
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining !== null) this.stats.remaining = Number(remaining);

    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubError(`GitHub ${response.status} for ${url}: ${text.slice(0, 200)}`, response.status, url);
    }
    const value = (text.length > 0 ? JSON.parse(text) : null) as T;
    await this.cache?.set(cacheKey, value);
    return value;
  }
}
