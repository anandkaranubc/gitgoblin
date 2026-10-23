import { createHash } from "node:crypto";
import { type CacheEntry, type HttpCache, isFresh, MemoryCache } from "./cache.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string, message = `HTTP ${status} for ${url}`) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class RateLimitError extends HttpError {
  readonly resetAt: Date | undefined;

  constructor(url: string, body: string, resetAt: Date | undefined) {
    const when = resetAt ? ` until ${resetAt.toISOString()}` : "";
    super(429, url, body, `Rate limited by ${new URL(url).host}${when}`);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
  }
}

export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export type HttpEvent =
  | { type: "hit"; url: string }
  | { type: "miss"; url: string }
  | { type: "revalidated"; url: string }
  | { type: "stale"; url: string; error: string }
  | { type: "retry"; url: string; attempt: number; delayMs: number; reason: string }
  | { type: "rate-limit-wait"; url: string; delayMs: number }
  | { type: "cache-discarded"; url: string; reason: string }
  | { type: "cache-fallback"; path: string; error: string };

export interface HttpClientOptions {
  cache?: HttpCache | undefined;
  fetch?: typeof fetch | undefined;
  userAgent?: string | undefined;
  /** Concurrent requests per host. */
  maxConcurrency?: number | undefined;
  /** Longest we will sleep for a rate-limit reset before giving up. */
  maxRateLimitWaitMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /** Largest response body accepted; bigger ones fail instead of being buffered and cached. */
  maxBodyBytes?: number | undefined;
  onEvent?: ((event: HttpEvent) => void) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface RequestOptions {
  method?: "GET" | "POST" | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  /** How long a 200 response is served from cache without contacting the server. */
  ttlMs?: number | undefined;
  /** How long a 404 is remembered. Defaults to ttlMs. */
  notFoundTtlMs?: number | undefined;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const RETRY_DELAYS_MS = [500, 2000];
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

class Semaphore {
  #active = 0;
  readonly #queue: Array<() => void> = [];
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    return () => {
      this.#active--;
      this.#queue.shift()?.();
    };
  }
}

/**
 * A fetch wrapper that caches responses, revalidates with ETags, honours
 * rate-limit headers and retries transient failures. Everything that talks to
 * the network in gitgoblin goes through here so budgets and caches are shared.
 */
export class HttpClient {
  readonly cache: HttpCache;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #maxRateLimitWaitMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxBodyBytes: number;
  readonly #onEvent: (event: HttpEvent) => void;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #semaphores = new Map<string, Semaphore>();
  readonly #maxConcurrency: number;
  readonly #rateLimits = new Map<string, RateLimitState>();

  constructor(options: HttpClientOptions = {}) {
    this.cache = options.cache ?? new MemoryCache();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? "gitgoblin/0.1.0";
    this.#maxConcurrency = options.maxConcurrency ?? 4;
    this.#maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Last known rate-limit state, keyed by "host" or "host/resource" (GitHub reports a resource). */
  rateLimits(): ReadonlyMap<string, RateLimitState> {
    return this.#rateLimits;
  }

  /** Drops one cached response, for callers that learn after the fact that a 200 body was not an answer. */
  forget(method: string, url: string, body?: string): void {
    this.cache.delete(cacheKey(method, url, body));
  }

  /**
   * Fetches JSON, serving from cache when fresh. Throws HttpError for non-2xx responses. A cached
   * body that no longer parses is discarded and fetched again, so a damaged cache heals itself.
   */
  async json<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const first = await this.#request(url, options, false);
    try {
      return JSON.parse(first.body) as T;
    } catch (error) {
      if (!first.fromCache) throw error;
      this.#onEvent({ type: "cache-discarded", url, reason: error instanceof Error ? error.message : String(error) });
      this.cache.delete(first.key);
      const second = await this.#request(url, options, true);
      return JSON.parse(second.body) as T;
    }
  }

  async text(url: string, options: RequestOptions = {}): Promise<string> {
    return (await this.#request(url, options, false)).body;
  }

  async #request(url: string, options: RequestOptions, bypassCache: boolean): Promise<{ body: string; fromCache: boolean; key: string }> {
    const method = options.method ?? "GET";
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const key = cacheKey(method, url, options.body);
    const cached = bypassCache ? undefined : this.cache.get(key);
    const now = this.#now();

    if (cached && isFresh(cached, now)) {
      this.#onEvent({ type: "hit", url });
      return { body: this.#unwrap(cached, url), fromCache: true, key };
    }
    this.#onEvent({ type: "miss", url });

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.#userAgent,
      ...lowercaseKeys(options.headers ?? {}),
    };
    if (options.body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    if (cached?.etag && cached.status === 200) headers["if-none-match"] = cached.etag;

    const release = await this.#semaphore(new URL(url).host).acquire();
    try {
      const result = await this.#fetchWithRetries(url, { method, headers, body: options.body }, key, cached, {
        ttlMs,
        notFoundTtlMs: options.notFoundTtlMs ?? ttlMs,
      });
      return { ...result, key };
    } finally {
      release();
    }
  }

  /** Reads a body up to the limit; past it the connection is dropped and the response rejected. */
  async #readBody(response: Response, url: string): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.#maxBodyBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(response.status, url, "", `Response from ${new URL(url).host} is larger than ${this.#maxBodyBytes} bytes`);
    }
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > this.#maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(response.status, url, "", `Response from ${new URL(url).host} is larger than ${this.#maxBodyBytes} bytes`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  #semaphore(host: string): Semaphore {
    let semaphore = this.#semaphores.get(host);
    if (!semaphore) {
      semaphore = new Semaphore(this.#maxConcurrency);
      this.#semaphores.set(host, semaphore);
    }
    return semaphore;
  }

  #unwrap(entry: CacheEntry, url: string): string {
    if (entry.status >= 200 && entry.status < 300) return entry.body;
    throw new HttpError(entry.status, url, entry.body);
  }

  async #fetchWithRetries(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string | undefined },
    key: string,
    cached: CacheEntry | undefined,
    ttl: { ttlMs: number; notFoundTtlMs: number },
  ): Promise<{ body: string; fromCache: boolean }> {
    let attempt = 0;
    let waitedForRateLimit = false;
    for (;;) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: init.method,
          headers: init.headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
      } catch (error) {
        const retryDelay = RETRY_DELAYS_MS[attempt];
        if (retryDelay !== undefined) {
          this.#onEvent({ type: "retry", url, attempt: ++attempt, delayMs: retryDelay, reason: String(error) });
          await this.#sleep(retryDelay);
          continue;
        }
        return { body: this.#staleOrThrow(cached, url, error), fromCache: true };
      }

      this.#recordRateLimit(url, response.headers);
      const now = this.#now();

      if (response.status === 304 && cached) {
        this.#onEvent({ type: "revalidated", url });
        this.cache.set(key, { ...cached, fetchedAt: now });
        return { body: this.#unwrap(cached, url), fromCache: true };
      }

      const body = await this.#readBody(response, url);

      if (response.ok) {
        this.cache.set(key, {
          status: response.status,
          body,
          etag: response.headers.get("etag"),
          fetchedAt: now,
          ttlMs: ttl.ttlMs,
        });
        return { body, fromCache: false };
      }

      if (response.status === 404) {
        this.cache.set(key, { status: 404, body, etag: null, fetchedAt: now, ttlMs: ttl.notFoundTtlMs });
        throw new HttpError(404, url, body);
      }

      if (isRateLimited(response)) {
        const resetAt = rateLimitReset(response.headers, now);
        const delayMs = resetAt ? Math.max(0, resetAt.getTime() - now) + 1000 : undefined;
        if (!waitedForRateLimit && delayMs !== undefined && delayMs <= this.#maxRateLimitWaitMs) {
          waitedForRateLimit = true;
          this.#onEvent({ type: "rate-limit-wait", url, delayMs });
          await this.#sleep(delayMs);
          continue;
        }
        if (cached) return { body: this.#staleOrThrow(cached, url, new RateLimitError(url, body, resetAt)), fromCache: true };
        throw new RateLimitError(url, body, resetAt);
      }

      if (response.status >= 500) {
        const retryDelay = RETRY_DELAYS_MS[attempt];
        if (retryDelay !== undefined) {
          this.#onEvent({ type: "retry", url, attempt: ++attempt, delayMs: retryDelay, reason: `HTTP ${response.status}` });
          await this.#sleep(retryDelay);
          continue;
        }
        return { body: this.#staleOrThrow(cached, url, new HttpError(response.status, url, body)), fromCache: true };
      }

      throw new HttpError(response.status, url, body);
    }
  }

  #staleOrThrow(cached: CacheEntry | undefined, url: string, error: unknown): string {
    if (cached && cached.status === 200) {
      this.#onEvent({ type: "stale", url, error: error instanceof Error ? error.message : String(error) });
      return cached.body;
    }
    throw error;
  }

  #recordRateLimit(url: string, headers: Headers): void {
    const limit = headers.get("x-ratelimit-limit");
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (limit === null || remaining === null || reset === null) return;
    const host = new URL(url).host;
    const resource = headers.get("x-ratelimit-resource");
    this.#rateLimits.set(resource ? `${host}/${resource}` : host, {
      limit: Number(limit),
      remaining: Number(remaining),
      resetAt: new Date(Number(reset) * 1000),
    });
  }
}

function cacheKey(method: string, url: string, body: string | undefined): string {
  if (body === undefined) return `${method} ${url}`;
  return `${method} ${url} ${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  // GitHub reports exhausted primary limits as 403 with x-ratelimit-remaining: 0,
  // and secondary limits as 403 with retry-after.
  if (response.status === 403) {
    return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  }
  return false;
}

function rateLimitReset(headers: Headers, now: number): Date | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return new Date(now + Number(retryAfter) * 1000);
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000);
  return undefined;
}
