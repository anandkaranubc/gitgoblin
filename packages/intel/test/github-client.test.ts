import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FetchGitHubApi, GitHubError, RateLimitError } from "../src/github/client.ts";
import { DiskCache } from "../src/util/cache.ts";
import type { FetchLike, HttpResponse } from "../src/util/http.ts";

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown; remaining?: number }): {
  fetchImpl: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const { status, body, remaining } = handler(url, init);
    const headers = new Headers();
    if (remaining !== undefined) headers.set("x-ratelimit-remaining", String(remaining));
    const response: HttpResponse = { status, headers, text: async () => JSON.stringify(body) };
    return response;
  };
  return { fetchImpl, calls };
}

describe("FetchGitHubApi", () => {
  it("sends auth and params and parses JSON", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true }, remaining: 4000 }));
    const api = new FetchGitHubApi({ token: "t0k", fetchImpl });
    const result = await api.rest<{ ok: boolean }>("/repos/a/b/issues", { per_page: 5 });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/a/b/issues?per_page=5");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    expect(api.stats).toEqual({ requests: 1, remaining: 4000 });
  });

  it("serves repeated requests from the disk cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitgoblin-cache-"));
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [1, 2] }));
    const api = new FetchGitHubApi({ fetchImpl, cache: new DiskCache(dir) });
    await api.rest("/repos/a/b");
    await api.rest("/repos/a/b");
    expect(calls).toHaveLength(1);
    expect(api.stats.requests).toBe(1);
  });

  it("throws GitHubError on non-2xx and RateLimitError when nearly exhausted", async () => {
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith("/missing") ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: {}, remaining: 3 },
    );
    const api = new FetchGitHubApi({ fetchImpl, minRemaining: 10 });
    await expect(api.rest("/repos/a/missing")).rejects.toBeInstanceOf(GitHubError);
    await api.rest("/repos/a/b");
    await expect(api.rest("/repos/a/c")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("unwraps GraphQL data and surfaces errors", async () => {
    const { fetchImpl, calls } = fakeFetch((_, init) =>
      String(init.body).includes("bad")
        ? { status: 200, body: { errors: [{ message: "boom" }] } }
        : { status: 200, body: { data: { repository: { id: 1 } } } },
    );
    const api = new FetchGitHubApi({ fetchImpl });
    const data = await api.graphql<{ repository: { id: number } }>("query { ok }");
    expect(data.repository.id).toBe(1);
    expect(calls[0]?.init.method).toBe("POST");
    await expect(api.graphql("query { bad }")).rejects.toThrow(/boom/);
  });
});
