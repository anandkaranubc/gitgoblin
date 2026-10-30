import { describe, expect, it } from "vitest";
import { GitHubClient, HttpClient, MemoryCache, MissingTokenError, RateLimitError, STARTER_ISSUE_LABELS } from "../src/index.ts";
import { fetchStub, fixture, jsonResponse } from "./helpers.ts";

function makeGitHub(handler: Parameters<typeof fetchStub>[0], token?: string) {
  const { fetch, calls } = fetchStub(handler);
  const http = new HttpClient({ cache: new MemoryCache(), fetch });
  return { github: new GitHubClient(http, { token }), calls };
}

describe("GitHubClient.searchRepositories", () => {
  it("maps search results to RepoFacts", async () => {
    const { github, calls } = makeGitHub(() => jsonResponse(fixture("github-search.json")), "t0k");
    const result = await github.searchRepositories("language:rust stars:20..300", { sort: "updated", perPage: 2 });

    expect(result.total).toBeGreaterThan(2);
    expect(result.items).toHaveLength(2);
    const first = result.items[0];
    expect(first).toMatchObject({
      host: "github.com",
      owner: "vayungodara",
      name: "cliproxy-rs",
      language: "Rust",
      license: "NOASSERTION",
      archived: false,
      fork: false,
    });
    expect(first?.topics).toContain("rust");
    expect(typeof first?.stars).toBe("number");
    expect(first?.pushedAt).toMatch(/^\d{4}-/);

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/search/repositories");
    expect(url.searchParams.get("q")).toBe("language:rust stars:20..300");
    expect(url.searchParams.get("per_page")).toBe("2");
    expect(calls[0]?.headers.authorization).toBe("Bearer t0k");
    expect(calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
  });
});

describe("GitHubClient.getRepository", () => {
  it("returns undefined for missing repositories", async () => {
    const { github } = makeGitHub(() => jsonResponse({ message: "Not Found" }, { status: 404 }));
    expect(await github.getRepository({ host: "github.com", owner: "nobody", name: "nothing" })).toBeUndefined();
  });

  it("never answers for a repository on another forge with the GitHub one of the same name", async () => {
    const { github, calls } = makeGitHub(() => jsonResponse(fixture<{ items: unknown[] }>("github-search.json").items[0]), "t0k");
    expect(await github.getRepository({ host: "gitlab.com", owner: "inkscape", name: "inkscape" })).toBeUndefined();
    expect((await github.repoDetails([{ host: "codeberg.org", owner: "forgejo", name: "forgejo" }])).size).toBe(0);
    expect(calls).toHaveLength(0);
    // Hosts compare normalized, so "GitHub.com" and "www.github.com" are still GitHub.
    expect(await github.getRepository({ host: "GitHub.com", owner: "a", name: "b" })).toBeDefined();
  });

  it("encodes owner and name in the path", async () => {
    const { github, calls } = makeGitHub(() => jsonResponse(fixture<{ items: unknown[] }>("github-search.json").items[0]));
    await github.getRepository({ host: "github.com", owner: "a b", name: "c" });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/a%20b/c");
  });
});

describe("GitHubClient.repoDetails", () => {
  it("requires a token", async () => {
    const { github } = makeGitHub(() => jsonResponse({}));
    await expect(github.repoDetails([{ host: "github.com", owner: "a", name: "b" }])).rejects.toBeInstanceOf(MissingTokenError);
  });

  it("batches repositories into one GraphQL request and maps the result", async () => {
    const { github, calls } = makeGitHub(() => jsonResponse(fixture("github-graphql-details.json")), "t0k");
    const refs = [
      { host: "github.com", owner: "BurntSushi", name: "ripgrep" },
      { host: "github.com", owner: "igtoth", name: "tracedraw" },
    ];
    const details = await github.repoDetails(refs);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { query: string; variables: Record<string, unknown> };
    expect(body.variables).toMatchObject({ o0: "BurntSushi", n0: "ripgrep", o1: "igtoth", n1: "tracedraw", starterLabels: STARTER_ISSUE_LABELS });
    expect(body.query).toContain("r1: repository(owner: $o1, name: $n1)");

    const ripgrep = details.get("github.com/burntsushi/ripgrep");
    expect(ripgrep).toMatchObject({
      hasContributing: true,
      hasCodeOfConduct: false,
      issueTemplates: 1,
      starterIssues: 9,
      openIssues: 130,
      mergedPullRequests: 571,
      commitCount: 2287,
      mentionableUsers: 444,
      archived: false,
    });
    expect(ripgrep?.starterIssueSamples[0]).toMatchObject({ title: expect.any(String), labels: expect.any(Array) });
    expect(details.get("github.com/igtoth/tracedraw")?.starterIssues).toBe(0);
  });

  it("skips repositories the API returned as null", async () => {
    const { github } = makeGitHub(() => jsonResponse({ data: { r0: null }, errors: [{ type: "NOT_FOUND" }] }), "t0k");
    const details = await github.repoDetails([{ host: "github.com", owner: "gone", name: "repo" }]);
    expect(details.size).toBe(0);
  });
});

describe("GitHubClient.repoDetails when GitHub cannot compute a batch", () => {
  const node = fixture<{ data: Record<string, unknown> }>("github-graphql-details.json").data["r0"];
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ host: "github.com", owner: "o", name: `r${i}` }));
  /** The repository names one GraphQL call asked for. */
  const asked = (body: string | undefined) => {
    const variables = (JSON.parse(body ?? "{}") as { variables: Record<string, unknown> }).variables;
    return Object.keys(variables).filter((k) => /^n\d+$/.test(k)).map((k) => String(variables[k]));
  };
  /** Answers every repository asked for, unless `fails` says the call should fail. */
  const answer = (fails: (names: string[], index: number) => Response | undefined) => (call: { body: string | undefined }, index: number) => {
    const names = asked(call.body);
    return fails(names, index) ?? jsonResponse({ data: Object.fromEntries(names.map((_, i) => [`r${i}`, node])) });
  };
  const badGateway = () => new Response("", { status: 502 });

  it("asks for at most 10 repositories per request", async () => {
    const { github, calls } = makeGitHub(answer(() => undefined), "t0k");
    const details = await github.repoDetails(refs(25));
    expect(calls.map((c) => asked(c.body).length)).toEqual([10, 10, 5]);
    expect(details.size).toBe(25);
  });

  it("splits a batch that timed out and keeps every repository", async () => {
    const { github, calls } = makeGitHub(answer((names) => (names.length === 10 ? badGateway() : undefined)), "t0k");
    const details = await github.repoDetails(refs(10));
    expect(calls.map((c) => asked(c.body).length)).toEqual([10, 5, 5]);
    expect(details.size).toBe(10);
  });

  it("leaves out only the repository GitHub cannot compute", async () => {
    const { github, calls } = makeGitHub(answer((names) => (names.includes("r7") ? badGateway() : undefined)), "t0k");
    const details = await github.repoDetails(refs(20));
    expect(details.size).toBe(19);
    expect(details.has("github.com/o/r7")).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  it("gives up after six failures in a row when nothing was fetched", async () => {
    const { github, calls } = makeGitHub(() => badGateway(), "t0k");
    await expect(github.repoDetails(refs(40))).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(6);
  });

  it("keeps what earlier batches fetched when GitHub starts failing", async () => {
    const { github, calls } = makeGitHub(answer((_names, index) => (index > 0 ? badGateway() : undefined)), "t0k");
    const details = await github.repoDetails(refs(40));
    expect(details.size).toBe(10);
    expect(calls).toHaveLength(7);
  });

  it("does not split on rate limits or bad credentials", async () => {
    const limited = makeGitHub(() => jsonResponse({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), "t0k");
    await expect(limited.github.repoDetails(refs(10))).rejects.toBeInstanceOf(RateLimitError);
    expect(limited.calls).toHaveLength(1);
    const denied = makeGitHub(() => jsonResponse({ message: "Bad credentials" }, { status: 401 }), "t0k");
    await expect(denied.github.repoDetails(refs(10))).rejects.toMatchObject({ status: 401 });
    expect(denied.calls).toHaveLength(1);
  });
});

describe("GitHubClient.graphql", () => {
  it("returns partial data when GitHub reports errors alongside it", async () => {
    const { github } = makeGitHub(
      () => jsonResponse({ data: { r0: { name: "kept" }, r1: null }, errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "too heavy" }] }),
      "t0k",
    );
    expect(await github.graphql("query { r0 r1 }")).toEqual({ r0: { name: "kept" }, r1: null });
  });

  it("throws GraphQLError only when no data came back", async () => {
    const { github } = makeGitHub(() => jsonResponse({ errors: [{ message: "Bad credentials" }] }), "t0k");
    await expect(github.graphql("query { viewer { login } }")).rejects.toMatchObject({ name: "GraphQLError", errors: [{ message: "Bad credentials" }] });
  });

  it("does not keep an errors-only answer in the cache, so the next call asks again", async () => {
    // GitHub answers an exhausted GraphQL budget with HTTP 200 and no data; one such body, cached for an
    // hour as a success, made every later identical query fail without touching the network.
    let n = 0;
    const { github, calls } = makeGitHub(() => {
      n += 1;
      return n === 1 ? jsonResponse({ errors: [{ type: "SOME_ERROR", message: "transient" }] }) : jsonResponse({ data: { ok: true } });
    }, "t0k");
    await expect(github.graphql("query { ok }")).rejects.toMatchObject({ name: "GraphQLError" });
    expect(await github.graphql("query { ok }")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("reports a GraphQL rate limit as a RateLimitError with the reset time", async () => {
    const { github } = makeGitHub(
      () =>
        jsonResponse(
          { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] },
          { headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000600", "x-ratelimit-resource": "graphql" } },
        ),
      "t0k",
    );
    const error = await github.graphql("query { ok }").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt?.toISOString()).toBe("2023-11-14T22:23:20.000Z");
  });

  it("still returns partial data with errors, and keeps it cached", async () => {
    const { github, calls } = makeGitHub(() => jsonResponse({ data: { r0: { name: "kept" } }, errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "too heavy" }] }), "t0k");
    expect(await github.graphql("query { r0 }")).toEqual({ r0: { name: "kept" } });
    expect(await github.graphql("query { r0 }")).toEqual({ r0: { name: "kept" } });
    expect(calls).toHaveLength(1);
  });
});

describe("GitHubClient.rest", () => {
  it("drops undefined params and exposes per-resource rate limits", async () => {
    const { github, calls } = makeGitHub(() =>
      jsonResponse({ ok: 1 }, { headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1700000000", "x-ratelimit-resource": "core" } }),
    );
    await github.rest("repos/o/n/issues", { params: { state: "open", labels: undefined, per_page: 5 } });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/n/issues?state=open&per_page=5");
    expect(github.rateLimits().core?.remaining).toBe(4999);
  });
});
