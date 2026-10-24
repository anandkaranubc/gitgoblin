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

  it("accepts only a forge's host name, never a path, an address, an option or a port it would drop", () => {
    expect(parseRepoRef("file:///etc/passwd/x")).toBeUndefined();
    expect(parseRepoRef("ftp://example.org/o/n")).toBeUndefined();
    expect(parseRepoRef("-x:o/n")).toBeUndefined();
    expect(parseRepoRef("git@-oProxyCommand=x:o/n")).toBeUndefined();
    expect(parseRepoRef("https://127.0.0.1/o/n")).toBeUndefined();
    expect(parseRepoRef("https://[::1]/o/n")).toBeUndefined();
    expect(parseRepoRef("10.0.0.1/o/n")).toBeUndefined();
    expect(parseRepoRef("https://git.example.org:8443/o/n")).toBeUndefined();
    expect(parseRepoRef("https://user:pass@github.com/o/n")).toBeUndefined();
    expect(parseRepoRef("localhost/o/n")).toBeUndefined();
    // Ordinary forms still work, including self-hosted forges and http.
    expect(parseRepoRef("http://git.example.org/o/n")).toEqual({ host: "git.example.org", owner: "o", name: "n" });
    expect(parseRepoRef("ssh://git@codeberg.org/forgejo/forgejo.git")).toEqual({ host: "codeberg.org", owner: "forgejo", name: "forgejo" });
    expect(parseRepoRef("git.sr.ht/o/n")).toEqual({ host: "git.sr.ht", owner: "o", name: "n" });
  });

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
