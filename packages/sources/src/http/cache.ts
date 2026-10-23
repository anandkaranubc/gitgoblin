import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

/** One cached HTTP response. `status` is kept so 404s can be cached too. */
export interface CacheEntry {
  status: number;
  body: string;
  etag: string | null;
  /** Epoch milliseconds. */
  fetchedAt: number;
  ttlMs: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
}

export interface HttpCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  /** Removes entries that expired more than `graceMs` ago. Returns how many were removed. */
  prune(graceMs: number, now?: number): number;
  stats(): CacheStats;
  close(): void;
}

export function isFresh(entry: CacheEntry, now: number): boolean {
  return now < entry.fetchedAt + entry.ttlMs;
}

/** In-memory cache for tests and short-lived scripts. */
export class MemoryCache implements HttpCache {
  readonly #entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.#entries.get(key);
  }
  set(key: string, entry: CacheEntry): void {
    this.#entries.set(key, entry);
  }
  delete(key: string): void {
    this.#entries.delete(key);
  }
  clear(): void {
    this.#entries.clear();
  }
  prune(graceMs: number, now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.fetchedAt + entry.ttlMs + graceMs < now) {
        this.#entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
  stats(): CacheStats {
    let bytes = 0;
    for (const entry of this.#entries.values()) bytes += entry.body.length;
    return { entries: this.#entries.size, bytes };
  }
  close(): void {}
}

interface Row {
  status: number;
  body: Uint8Array | string;
  etag: string | null;
  fetched_at: number;
  ttl_ms: number;
}

/** Entries that expired longer ago than this are dropped when the cache opens. */
const OPEN_PRUNE_GRACE_MS = 7 * 86_400_000;

/**
 * Persistent cache on Node's built-in SQLite. Pass ":memory:" for an ephemeral
 * database. Bodies are gzipped: API responses are large JSON and compress ~10x.
 */
export class SqliteCache implements HttpCache {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS http_cache (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body BLOB NOT NULL,
        etag TEXT,
        fetched_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL
      );
    `);
    this.prune(OPEN_PRUNE_GRACE_MS);
  }

  get(key: string): CacheEntry | undefined {
    const row = this.#db
      .prepare("SELECT status, body, etag, fetched_at, ttl_ms FROM http_cache WHERE key = ?")
      .get(key) as Row | undefined;
    if (!row) return undefined;
    return {
      status: row.status,
      // Rows written before compression was added are plain text.
      body: typeof row.body === "string" ? row.body : gunzipSync(row.body).toString("utf8"),
      etag: row.etag,
      fetchedAt: row.fetched_at,
      ttlMs: row.ttl_ms,
    };
  }

  set(key: string, entry: CacheEntry): void {
    this.#db
      .prepare(
        `INSERT INTO http_cache (key, status, body, etag, fetched_at, ttl_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           status = excluded.status, body = excluded.body, etag = excluded.etag,
           fetched_at = excluded.fetched_at, ttl_ms = excluded.ttl_ms`,
      )
      .run(key, entry.status, gzipSync(entry.body), entry.etag, entry.fetchedAt, entry.ttlMs);
  }

  delete(key: string): void {
    this.#db.prepare("DELETE FROM http_cache WHERE key = ?").run(key);
  }

  clear(): void {
    this.#db.exec("DELETE FROM http_cache");
  }

  prune(graceMs: number, now = Date.now()): number {
    const result = this.#db
      .prepare("DELETE FROM http_cache WHERE fetched_at + ttl_ms + ? < ?")
      .run(graceMs, now);
    return Number(result.changes);
  }

  stats(): CacheStats {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM http_cache")
      .get() as { entries: number; bytes: number };
    return { entries: Number(row.entries), bytes: Number(row.bytes) };
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Where the on-disk cache lives: $GITGOBLIN_CACHE_DIR, else $XDG_CACHE_HOME/gitgoblin,
 * else ~/.cache/gitgoblin.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITGOBLIN_CACHE_DIR) return env.GITGOBLIN_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "gitgoblin");
}

export function defaultCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCacheDir(env), "http-cache.sqlite");
}
