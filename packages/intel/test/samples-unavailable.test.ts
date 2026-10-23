import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepository } from "../src/index.ts";
import { type GitHubApi, RateLimitError } from "../src/github/client.ts";
import { FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * The CLI tells people when issues could not be read, keyed on this note's prefix, so the prefix and the
 * truncation flag are a contract: a report without issue and PR samples must say so and must say it is partial.
 */
describe("issue and PR samples that GitHub refuses", () => {
  let fixture: FixtureRepo;
  let cacheDir: string;
  beforeAll(async () => {
    fixture = await FixtureRepo.create();
    await fixture.commit({ files: { "README.md": "# r\n\nA small library.\n", "r/__init__.py": "def f():\n    return 1\n", "pyproject.toml": "[project]\nname = \"r\"\n" } });
    cacheDir = await mkdtemp(join(tmpdir(), "gitgoblin-cache-"));
    process.env.GITGOBLIN_BURST_RETRY_MS = "10";
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
    delete process.env.GITGOBLIN_BURST_RETRY_MS;
  });

  it("marks the report truncated and explains why, with the stable prefix", async () => {
    let graphqlCalls = 0;
    const github = {
      stats: { requests: 0, remaining: 3967 },
      rest: async (path: string) => {
        if (path === "/repos/o/r") return { owner: { login: "o" }, name: "r", default_branch: "main", description: "d", homepage: null, topics: [], stargazers_count: 1, forks_count: 0, subscribers_count: 0, open_issues_count: 3, license: null, archived: false, disabled: false, fork: false, is_template: false, has_issues: true, size: 1, created_at: "2020-01-01T00:00:00Z", pushed_at: "2026-10-01T00:00:00Z" };
        throw new Error("not needed");
      },
      graphql: async () => {
        graphqlCalls++;
        throw new RateLimitError("/graphql", 3967, { refused: true });
      },
    } as unknown as GitHubApi;
    const report = await analyzeRepository({ owner: "o", name: "r", localPath: fixture.dir }, { github, cacheDir, checkLinks: false, dependencyChecks: false });
    const note = report.budget.notes.find((n) => n.startsWith("issue and PR samples unavailable: "));
    expect(note).toBe("issue and PR samples unavailable: GitHub refused requests as rate limited (secondary limit; 3967 of the hourly quota left); issues and pull requests were not analyzed, try again in a minute");
    expect(report.budget.truncated).toBe(true);
    expect(graphqlCalls).toBe(2); // one retry after the burst refusal
  }, 60_000);
});
