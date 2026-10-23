import { describe, expect, it } from "vitest";
import { RepositoryNotFoundError, analyzeRepository } from "../src/index.ts";
import { GitHubError, type GitHubApi } from "../src/github/client.ts";

describe("missing repositories", () => {
  it("raises a typed not-found error when GitHub answers 404 for the repository", async () => {
    const github = {
      stats: { requests: 0 },
      rest: async (path: string) => { throw new GitHubError(`HTTP 404 for https://api.github.com${path}`, 404, path); },
      graphql: async () => { throw new Error("not reached"); },
    } as unknown as GitHubApi;
    const error = await analyzeRepository("not/a-real-repo-xyz", { github, cacheDir: "/tmp/gitgoblin-test-cache" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepositoryNotFoundError);
    expect(error).toMatchObject({ name: "RepositoryNotFoundError", message: "not/a-real-repo-xyz was not found on github.com", owner: "not", repo: "a-real-repo-xyz", host: "github.com" });
  });
});
