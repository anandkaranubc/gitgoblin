import { describe, expect, it } from "vitest";
import { EcosystemsClient, HttpClient, MemoryCache } from "../src/index.ts";
import { fetchStub, fixture, jsonResponse } from "./helpers.ts";

const ripgrep = { host: "github.com", owner: "BurntSushi", name: "ripgrep" };

function makeClient(handler: Parameters<typeof fetchStub>[0]) {
  const { fetch, calls } = fetchStub(handler);
  return { client: new EcosystemsClient(new HttpClient({ cache: new MemoryCache(), fetch })), calls };
}

describe("EcosystemsClient", () => {
  it("looks up a repository by URL and normalizes it", async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture("ecosystems-repo.json")));
    const repo = await client.lookupRepository(ripgrep);

    expect(calls[0]?.url).toBe("https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/BurntSushi%2Fripgrep");
    expect(repo).toMatchObject({
      fullName: "BurntSushi/ripgrep",
      language: "Rust",
      license: "unlicense",
      archived: false,
      hasFunding: true,
      scorecardScore: 4.6,
    });
    expect(repo?.commitStats).toMatchObject({ totalCommits: 1988, totalCommitters: 406 });
    expect(repo?.commitStats?.dds).toBeCloseTo(0.3048, 3);
    expect(repo?.files).toMatchObject({ readme: "README.md", contributing: "CONTRIBUTING.md" });
    expect(repo?.files.code_of_conduct).toBeUndefined();
    expect(repo?.topics).toContain("grep");
  });

  it("returns undefined for unknown repositories", async () => {
    const { client } = makeClient(() => jsonResponse({ error: "not found" }, { status: 404 }));
    expect(await client.lookupRepository(ripgrep)).toBeUndefined();
  });

  it("lists packages published from a repository", async () => {
    const { client } = makeClient(() => jsonResponse(fixture("ecosystems-packages.json")));
    const packages = await client.lookupPackages({ host: "github.com", owner: "sindresorhus", name: "p-limit" });

    expect(packages).toHaveLength(2);
    expect(packages[0]).toMatchObject({
      name: "p-limit",
      ecosystem: "npm",
      registry: "npmjs.org",
      dependentPackages: 3167,
    });
    expect(packages[0]?.keywords).toContain("concurrency");
    expect(packages[0]?.dependentRepos).toBeGreaterThan(1_000_000);
  });

  it("returns an empty list when a repository has no packages", async () => {
    const { client } = makeClient(() => jsonResponse(undefined, { status: 404 }));
    expect(await client.lookupPackages(ripgrep)).toEqual([]);
  });

  it("normalizes issue statistics", async () => {
    const { client } = makeClient(() => jsonResponse(fixture("ecosystems-issues.json")));
    const stats = await client.lookupIssueStats(ripgrep);
    expect(stats).toMatchObject({ issues: 502, pullRequests: 580, mergedPullRequests: 126 });
    expect(stats?.pastYear).toMatchObject({ issues: 63, pullRequests: 178, prAuthors: 116 });
    expect(stats?.pastYear.avgTimeToCloseIssueSec).toBeCloseTo(2198003.96, 1);
  });
});

describe("EcosystemsClient routing", () => {
  it("uses the generic lookup for forges without a known host name", async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture("ecosystems-repo.json")));
    await client.lookupRepository({ host: "codeberg.org", owner: "forgejo", name: "forgejo" });
    expect(calls[0]?.url).toBe("https://repos.ecosyste.ms/api/v1/repositories/lookup?url=https%3A%2F%2Fcodeberg.org%2Fforgejo%2Fforgejo");
  });
});
