import { describe, expect, it } from "vitest";
import { HttpClient, HttpError, type HttpEvent, MemoryCache, RateLimitError } from "../src/index.ts";
import { fetchStub, jsonResponse, virtualClock } from "./helpers.ts";

const URL_A = "https://api.example.com/a";

function makeClient(fetchFn: typeof globalThis.fetch, clock = virtualClock(), extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const events: HttpEvent[] = [];
  const client = new HttpClient({
    cache: new MemoryCache(),
    fetch: fetchFn,
    now: clock.now,
    sleep: clock.sleep,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { client, events };
}

describe("HttpClient caching", () => {
  it("serves fresh entries without touching the network", async () => {
    const clock = virtualClock();
    const { fetch, calls } = fetchStub(() => jsonResponse({ n: 1 }, { headers: { etag: '"v1"' } }));
    const { client, events } = makeClient(fetch, clock);

    expect(await client.json(URL_A, { ttlMs: 1000 })).toEqual({ n: 1 });
    clock.advance(500);
    expect(await client.json(URL_A, { ttlMs: 1000 })).toEqual({ n: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["user-agent"]).toMatch(/^gitgoblin\//);
    expect(events.map((e) => e.type)).toEqual(["miss", "hit"]);
  });

  it("revalidates stale entries with If-None-Match and accepts 304", async () => {
    const clock = virtualClock();
    const { fetch, calls } = fetchStub((_call, i) =>
      i === 0 ? jsonResponse({ n: 1 }, { headers: { etag: '"v1"' } }) : new Response(null, { status: 304 }),
    );
    const { client, events } = makeClient(fetch, clock);

    await client.json(URL_A, { ttlMs: 1000 });
    clock.advance(2000);
    expect(await client.json(URL_A, { ttlMs: 1000 })).toEqual({ n: 1 });
    expect(calls[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(events.map((e) => e.type)).toEqual(["miss", "miss", "revalidated"]);

    // The 304 refreshed the entry, so the next read is a hit.
    clock.advance(500);
    await client.json(URL_A, { ttlMs: 1000 });
    expect(calls).toHaveLength(2);
  });

  it("remembers 404s for the not-found ttl", async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse({ message: "Not Found" }, { status: 404 }));
    const { client } = makeClient(fetch);

    await expect(client.json(URL_A, { ttlMs: 1000, notFoundTtlMs: 1000 })).rejects.toBeInstanceOf(HttpError);
    await expect(client.json(URL_A, { ttlMs: 1000, notFoundTtlMs: 1000 })).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("keys POST requests by body so different GraphQL queries do not collide", async () => {
    const { fetch, calls } = fetchStub((call) => jsonResponse({ echo: call.body }));
    const { client } = makeClient(fetch);

    await client.json(URL_A, { method: "POST", body: '{"q":1}' });
    await client.json(URL_A, { method: "POST", body: '{"q":2}' });
    await client.json(URL_A, { method: "POST", body: '{"q":1}' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });
});

describe("HttpClient resilience", () => {
  it("waits for a short rate-limit reset and retries once", async () => {
    const clock = virtualClock();
    const { fetch, calls } = fetchStub((_call, i) =>
      i === 0
        ? jsonResponse({ message: "slow down" }, { status: 403, headers: { "retry-after": "2", "x-ratelimit-remaining": "0" } })
        : jsonResponse({ ok: true }),
    );
    const { client, events } = makeClient(fetch, clock);

    expect(await client.json(URL_A)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([3000]);
    expect(events.some((e) => e.type === "rate-limit-wait")).toBe(true);
  });

  it("throws RateLimitError when the reset is too far away", async () => {
    const clock = virtualClock();
    const reset = Math.floor(clock.now() / 1000) + 3600;
    const { fetch } = fetchStub(() =>
      jsonResponse({}, { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }),
    );
    const { client } = makeClient(fetch, clock);

    await expect(client.json(URL_A)).rejects.toBeInstanceOf(RateLimitError);
    await expect(client.json(URL_A)).rejects.toMatchObject({ resetAt: new Date(reset * 1000) });
  });

  it("retries server errors and falls back to a stale copy", async () => {
    const clock = virtualClock();
    const { fetch, calls } = fetchStub((_call, i) => (i === 0 ? jsonResponse({ n: 1 }) : new Response("boom", { status: 503 })));
    const { client, events } = makeClient(fetch, clock);

    await client.json(URL_A, { ttlMs: 10 });
    clock.advance(100);
    expect(await client.json(URL_A, { ttlMs: 10 })).toEqual({ n: 1 });
    expect(calls).toHaveLength(4);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("stale");
  });

  it("surfaces network failures when nothing is cached", async () => {
    const { fetch } = fetchStub(() => {
      throw new TypeError("fetch failed");
    });
    const { client } = makeClient(fetch);
    await expect(client.json(URL_A)).rejects.toThrow("fetch failed");
  });

  it("records rate-limit headers per host and resource", async () => {
    const { fetch } = fetchStub(() =>
      jsonResponse({}, { headers: { "x-ratelimit-limit": "30", "x-ratelimit-remaining": "7", "x-ratelimit-reset": "1700000000", "x-ratelimit-resource": "search" } }),
    );
    const { client } = makeClient(fetch);
    await client.json("https://api.github.com/search/repositories?q=x");
    expect(client.rateLimits().get("api.github.com/search")).toEqual({
      limit: 30,
      remaining: 7,
      resetAt: new Date(1_700_000_000_000),
    });
  });

  it("limits concurrent requests per host", async () => {
    let active = 0;
    let peak = 0;
    const { fetch } = fetchStub(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return jsonResponse({});
    });
    const { client } = makeClient(fetch, virtualClock(), { maxConcurrency: 2 });
    await Promise.all([1, 2, 3, 4, 5].map((i) => client.json(`${URL_A}?i=${i}`)));
    expect(peak).toBe(2);
  });
});
