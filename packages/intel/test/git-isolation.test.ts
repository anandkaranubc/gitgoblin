import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDirFor, ensureClone, git } from "../src/git/repo.ts";
import { PrivateRepositoryError, fetchRepoMeta } from "../src/github/fetch.ts";
import type { GitHubApi } from "../src/github/client.ts";
import { FixtureRepo } from "./helpers/fixture-repo.ts";

/** These go through intel's own git(), the path every analysis takes, not through a raw git call. */
describe("git runs isolated from the user's configuration", () => {
  let fixture: FixtureRepo;
  beforeAll(async () => {
    fixture = await FixtureRepo.create();
    await fixture.commit({ files: { "README.md": "# r\n" } });
  });
  afterAll(() => fixture.cleanup());

  it("reads no system or global config, only the repository's own and intel's fixed settings", async () => {
    const list = await git(["config", "--show-origin", "--list"], fixture.dir);
    const origins = list.split("\n").filter(Boolean).map((l) => l.split("\t")[0]!);
    const outside = origins.filter((o) => !o.startsWith("command line:") && !o.includes(".git/config"));
    expect(outside).toEqual([]);
    expect((await git(["config", "--get", "core.symlinks"], fixture.dir)).trim()).toBe("false");
    expect((await git(["config", "--get", "protocol.allow"], fixture.dir)).trim()).toBe("never");
    expect((await git(["config", "--get-all", "credential.helper"], fixture.dir)).trim()).toBe("");
  });

  it("refuses every transport but https", async () => {
    await expect(git(["ls-remote", `file://${fixture.dir}`], fixture.dir)).rejects.toThrow(/transport 'file' not allowed/);
  });
});

describe("clone cache", () => {
  let cacheDir: string;
  beforeAll(async () => { cacheDir = await mkdtemp(join(tmpdir(), "gitgoblin-cache-")); });
  afterAll(async () => { await rm(cacheDir, { recursive: true, force: true }); });

  it("keeps one clone per host, owner and name", () => {
    const github = cloneDirFor(cacheDir, { host: "github.com", owner: "a", name: "b" });
    const codeberg = cloneDirFor(cacheDir, { host: "codeberg.org", owner: "a", name: "b" });
    expect(github).not.toBe(codeberg);
    expect(cloneDirFor(cacheDir, { host: "gitlab.com", owner: "a__b", name: "c" })).not.toBe(cloneDirFor(cacheDir, { host: "gitlab.com", owner: "a", name: "b__c" }));
  });

  it("never fetches into a clone made from another URL", async () => {
    const ref = { host: "example.invalid", owner: "o", name: "r" };
    const dir = cloneDirFor(cacheDir, ref);
    await mkdir(dir, { recursive: true });
    const impostor = await FixtureRepo.create();
    await impostor.commit({ files: { "README.md": "# the impostor\n" } });
    await rm(dir, { recursive: true, force: true });
    await impostor.git(["clone", "-q", impostor.dir, dir]); // origin is the impostor's path, not https://example.invalid/o/r.git
    await writeFile(join(dir, "marker"), "x");
    await expect(ensureClone(ref, { cacheDir, timeoutMs: 20_000 })).rejects.toThrow();
    expect(existsSync(join(dir, "marker"))).toBe(false);
    await impostor.cleanup();
  });
});

describe("private repositories", () => {
  it("are refused before anything is cloned", async () => {
    const api = { rest: async () => ({ private: true, visibility: "private", name: "r", owner: { login: "o" }, default_branch: "main" }) } as unknown as GitHubApi;
    await expect(fetchRepoMeta(api, "o", "r")).rejects.toBeInstanceOf(PrivateRepositoryError);
  });
});
