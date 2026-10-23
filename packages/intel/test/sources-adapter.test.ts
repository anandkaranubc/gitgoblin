import { describe, expect, it } from "vitest";
import { RateLimitError, GitHubError } from "../src/github/client.ts";
import { type SourcesLike, adaptSources } from "../src/github/sources-adapter.ts";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

function fake(): SourcesLike & { closed: boolean; seen: unknown[] } {
  const state = {
    closed: false,
    seen: [] as unknown[],
    github: {
      async rest<T>(path: string, options?: { params?: Record<string, string | number> }): Promise<T> {
        state.seen.push([path, options]);
        if (path.endsWith("/missing")) throw new HttpError(404);
        return { path } as T;
      },
      async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
        state.seen.push([query, variables]);
        if (query.includes("limited")) throw Object.assign(new Error("Rate limited by api.github.com"), { name: "RateLimitError", status: 429 });
        return { repository: { ok: true } } as T;
      },
      rateLimits: () => ({ core: { remaining: 4321 }, graphql: { remaining: 4000 } }),
    },
    close: () => { state.closed = true; },
  };
  return state;
}

describe("adaptSources", () => {
  it("forwards rest and graphql calls, tracks stats and closes", async () => {
    const sources = fake();
    const api = adaptSources(sources);
    expect(await api.rest("/repos/o/r", { per_page: 5 })).toEqual({ path: "/repos/o/r" });
    expect(sources.seen[0]).toEqual(["/repos/o/r", { params: { per_page: 5 } }]);
    expect(await api.graphql("query { x }", { a: 1 })).toEqual({ repository: { ok: true } });
    expect(api.stats).toEqual({ requests: 2, remaining: 4000 });
    api.close();
    expect(sources.closed).toBe(true);
  });

  it("translates the shared client's RateLimitError into intel's, so callers stop or wait", async () => {
    const api = adaptSources(fake());
    await expect(api.graphql("query limited {}")).rejects.toBeInstanceOf(RateLimitError);
    await expect(api.graphql("query limited {}")).rejects.toMatchObject({ status: 429 });
  });

  it("translates HttpError into GitHubError with the status", async () => {
    const api = adaptSources(fake());
    await expect(api.rest("/repos/o/missing")).rejects.toMatchObject({ name: "GitHubError", status: 404 });
    await expect(api.rest("/repos/o/missing")).rejects.toBeInstanceOf(GitHubError);
  });
});
