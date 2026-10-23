import { describe, expect, it } from "vitest";
import { GitHubClient, HttpClient, MemoryCache, MissingTokenError, STARTER_ISSUE_LABELS } from "../src/index.ts";
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
