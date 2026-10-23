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
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe("/xdg/gitgoblin");
    expect(defaultCacheDir({})).toMatch(/\.cache\/gitgoblin$/);
  });
});
