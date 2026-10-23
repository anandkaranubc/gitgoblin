import { describe, expect, it } from "vitest";
import { normalizeHost, parseRepoRef, repoId, repoUrl, sameRepo, toRepoRef } from "../src/index.ts";

describe("parseRepoRef", () => {
  it("parses owner/name with the default host", () => {
    expect(parseRepoRef("BurntSushi/ripgrep")).toEqual({
      host: "github.com",
      owner: "BurntSushi",
      name: "ripgrep",
    });
  });

  it("parses host/owner/name", () => {
    expect(parseRepoRef("codeberg.org/forgejo/forgejo")).toEqual({
      host: "codeberg.org",
      owner: "forgejo",
      name: "forgejo",
    });
  });

  it("parses https URLs with .git suffix and trailing paths", () => {
    expect(parseRepoRef("https://github.com/rails/rails.git")).toEqual({
      host: "github.com",
      owner: "rails",
      name: "rails",
    });
    expect(parseRepoRef("https://gitlab.com/inkscape/inkscape/-/issues")).toEqual({
      host: "gitlab.com",
      owner: "inkscape",
      name: "inkscape",
    });
  });

  it("parses ssh remotes", () => {
    expect(parseRepoRef("git@github.com:sindresorhus/p-limit.git")).toEqual({
      host: "github.com",
      owner: "sindresorhus",
      name: "p-limit",
    });
  });

  it("rejects things that are not repositories", () => {
    expect(parseRepoRef("")).toBeUndefined();
    expect(parseRepoRef("ripgrep")).toBeUndefined();
    expect(parseRepoRef("a/b/c")).toBeUndefined();
    expect(parseRepoRef("https://github.com/only-owner")).toBeUndefined();
    expect(parseRepoRef("owner/name with spaces")).toBeUndefined();
    expect(parseRepoRef("../../etc/passwd")).toBeUndefined();
  });
});

describe("identity helpers", () => {
  const ref = { host: "GitHub", owner: "Rails", name: "Rails" };

  it("normalizes hosts and aliases", () => {
    expect(normalizeHost("GitHub")).toBe("github.com");
    expect(normalizeHost("www.GitLab.com")).toBe("gitlab.com");
    expect(normalizeHost("git.example.org")).toBe("git.example.org");
  });

  it("builds a stable lowercase id and a browsable url", () => {
    expect(repoId(ref)).toBe("github.com/rails/rails");
    expect(repoUrl(ref)).toBe("https://github.com/Rails/Rails");
  });

  it("compares refs case-insensitively", () => {
    expect(sameRepo(ref, { host: "github.com", owner: "rails", name: "rails" })).toBe(true);
    expect(sameRepo(ref, { host: "gitlab.com", owner: "rails", name: "rails" })).toBe(false);
  });

  it("strips extra fields down to a RepoRef", () => {
    const facts = { ...ref, stars: 5, url: "x" };
    expect(toRepoRef(facts)).toEqual({ host: "github.com", owner: "Rails", name: "Rails" });
  });
});
