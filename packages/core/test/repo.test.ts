import { describe, expect, it } from "vitest";
import { normalizeHost, parseRepoRef, repoId, repoUrl, sameRepo, toRepoRef } from "../src/index.ts";
import { isForgeHost } from "../src/repo.ts";

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

  it("accepts names forges allow with a leading dot or underscore or a trailing underscore", () => {
    expect(parseRepoRef("microsoft/.github")).toEqual({ host: "github.com", owner: "microsoft", name: ".github" });
    expect(parseRepoRef("https://github.com/github/.github")).toEqual({ host: "github.com", owner: "github", name: ".github" });
    expect(parseRepoRef("octo/_site")?.name).toBe("_site");
    expect(parseRepoRef("octo/repo_")?.name).toBe("repo_");
    for (const name of [".", "..", "-x", "a\u0000b", "a\nb"]) expect(parseRepoRef(`octo/${name}`)).toBeUndefined();
    expect(parseRepoRef("https://github.com/octo/..")).toBeUndefined();
  });

  it("refuses a GitLab project in a subgroup instead of cutting it down to its group", () => {
    expect(parseRepoRef("https://gitlab.com/gitlab-org/security-products/analyzers/semgrep")).toBeUndefined();
    expect(parseRepoRef("https://gitlab.com/gitlab-org/security-products/analyzers/semgrep/-/issues/7")).toBeUndefined();
    expect(parseRepoRef("https://gitlab.gnome.org/World/Rust/gtk-rs")).toBeUndefined();
    expect(parseRepoRef("https://gitlab.com/inkscape/inkscape/-/merge_requests/1")).toEqual({ host: "gitlab.com", owner: "inkscape", name: "inkscape" });
    // Elsewhere, paths past owner/name are pages of the repository.
    expect(parseRepoRef("https://github.com/o/n/tree/main/-/x")).toEqual({ host: "github.com", owner: "o", name: "n" });
    expect(parseRepoRef("https://codeberg.org/o/n/src/branch/main")).toEqual({ host: "codeberg.org", owner: "o", name: "n" });
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
    // Numeric forms URLs and the system resolver read as IPv4 addresses: 127.0.0.1 and 169.254.169.254.
    for (const input of ["0x7f.1/o/n", "0xa9.254.169.254/o/n", "git@0x7f.0.0.1:o/n.git", "017.0.0.1/o/n", "127.1/o/n", "example.123/o/n", "a.0x/o/n"]) {
      expect(parseRepoRef(input)).toBeUndefined();
    }
    expect(isForgeHost("0x7f.1")).toBe(false);
    expect(isForgeHost("0x7f.example.org")).toBe(true);
    expect(isForgeHost("1.2.3.example")).toBe(true);
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
