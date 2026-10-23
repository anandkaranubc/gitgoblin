import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type HttpCache, MemoryCache, SqliteCache, defaultCacheDir, isFresh } from "../src/index.ts";

const entry = { status: 200, body: '{"a":1}', etag: 'W/"x"', fetchedAt: 1000, ttlMs: 500 };

describe.each([
  ["MemoryCache", () => new MemoryCache()],
  ["SqliteCache", () => new SqliteCache(":memory:")],
])("%s", (_name, make: () => HttpCache) => {
  it("stores, replaces and deletes entries", () => {
    const cache = make();
    expect(cache.get("k")).toBeUndefined();
    cache.set("k", entry);
    expect(cache.get("k")).toEqual(entry);
    cache.set("k", { ...entry, body: "2", etag: null });
    expect(cache.get("k")?.body).toBe("2");
    expect(cache.get("k")?.etag).toBeNull();
    cache.delete("k");
    expect(cache.get("k")).toBeUndefined();
    cache.close();
  });

  it("prunes entries that expired beyond the grace period", () => {
    const cache = make();
    cache.set("old", { ...entry, fetchedAt: 0, ttlMs: 10 });
    cache.set("recent", { ...entry, fetchedAt: 900, ttlMs: 10 });
    cache.set("fresh", { ...entry, fetchedAt: 1000, ttlMs: 10_000 });
    expect(cache.prune(100, 1000)).toBe(1);
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("recent")).toBeDefined();
    expect(cache.stats().entries).toBe(2);
    expect(cache.stats().bytes).toBeGreaterThan(0);
    cache.clear();
    expect(cache.stats().entries).toBe(0);
    cache.close();
  });
});

describe("SqliteCache compression", () => {
  it("stores bodies compressed and reads them back intact", () => {
    const cache = new SqliteCache(":memory:");
    const body = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `repository-${i}`, topics: ["a", "b"] })) });
    cache.set("big", { ...entry, body });
    expect(cache.get("big")?.body).toBe(body);
    expect(cache.stats().bytes).toBeLessThan(body.length / 4);
    cache.close();
  });
});

describe("isFresh", () => {
  it("is fresh strictly before fetchedAt + ttl", () => {
    expect(isFresh(entry, 1499)).toBe(true);
    expect(isFresh(entry, 1500)).toBe(false);
  });
});

describe("defaultCacheDir", () => {
  it("prefers GITGOBLIN_CACHE_DIR, then XDG_CACHE_HOME", () => {
    expect(defaultCacheDir({ GITGOBLIN_CACHE_DIR: "/tmp/gg" })).toBe("/tmp/gg");
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe(path.join("/xdg", "gitgoblin"));
    expect(defaultCacheDir({})).toMatch(/\.cache[\\/]gitgoblin$/);
  });
});

describe("SqliteCache on disk", () => {
  const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), "gg-cache-")), "nested", "http-cache.sqlite");

  it.skipIf(process.platform === "win32")("keeps the cache private to the user", () => {
    const dbPath = file();
    const cache = new SqliteCache(dbPath);
    cache.set("k", entry);
    cache.close();
    expect(statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("drops a row it cannot decode instead of failing every request", () => {
    const dbPath = file();
    const cache = new SqliteCache(dbPath);
    const fresh = { ...entry, fetchedAt: Date.now(), ttlMs: 60_000 };
    cache.set("good", fresh);
    cache.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO http_cache (key, status, body, etag, fetched_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?)").run("bad", 200, new Uint8Array([1, 2, 3]), null, Date.now(), 60_000);
    db.close();
    const reopened = new SqliteCache(dbPath);
    expect(reopened.get("bad")).toBeUndefined();
    expect(reopened.get("good")).toEqual(fresh);
    expect(reopened.stats().entries).toBe(1);
    reopened.close();
  });

  it("evicts the oldest entries when the cache grows past its size limit", () => {
    const dbPath = file();
    const cache = new SqliteCache(dbPath, { maxBytes: 1 });
    const big = "x".repeat(5000) + Math.random();
    const now = Date.now();
    cache.set("a", { ...entry, body: big + "a", fetchedAt: now - 3000, ttlMs: 60_000 });
    cache.set("b", { ...entry, body: big + "b", fetchedAt: now - 2000, ttlMs: 60_000 });
    cache.set("c", { ...entry, body: big + "c", fetchedAt: now - 1000, ttlMs: 60_000 });
    expect(cache.stats().entries).toBe(3);
    cache.close();
    const reopened = new SqliteCache(dbPath, { maxBytes: 1 });
    expect(reopened.stats().entries).toBeLessThanOrEqual(1);
    expect(reopened.get("a")).toBeUndefined();
    reopened.close();
  });
});

describe("createSources cache fallback", () => {
  it("falls back to memory when the cache file cannot be opened", async () => {
    const { createSources } = await import("../src/index.ts");
    const events: unknown[] = [];
    const blocked = path.join(mkdtempSync(path.join(os.tmpdir(), "gg-cache-")), "file-not-dir");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blocked, "not a directory");
    const sources = await createSources({ cachePath: path.join(blocked, "x", "cache.sqlite"), token: "t", onEvent: (e) => events.push(e) });
    expect(sources.cache).toBeInstanceOf(MemoryCache);
    expect(events).toContainEqual(expect.objectContaining({ type: "cache-fallback" }));
    sources.close();
  });
});
