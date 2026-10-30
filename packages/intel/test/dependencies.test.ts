import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedVersion } from "../src/analyzers/dependencies.ts";
import { parseLockfile } from "../src/analyzers/lockfiles.ts";
import type { GitHubApi } from "../src/github/client.ts";
import { analyzeRepository } from "../src/index.ts";
import { FixtureRepo } from "./helpers/fixture-repo.ts";

const django = { ecosystem: "PyPI" as const, name: "django", version: "4.2.5", dev: false };
const range = (introduced: string, fixed: string) => ({ package: { name: "django", ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced }, { fixed }] }] });
const VULNS: Record<string, unknown> = {
  A: { id: "A", summary: "a", database_specific: { severity: "HIGH" }, affected: [range("0", "4.2.9")] },
  B: { id: "B", summary: "b", database_specific: { severity: "HIGH" }, affected: [range("5.0", "5.0.8"), range("4.2", "4.2.15")] },
  "GO-1": { id: "GO-1", summary: "net", database_specific: { severity: "HIGH" }, affected: [{ package: { name: "golang.org/x/net", ecosystem: "Go" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "0.17.0" }] }] }] },
};

describe("fixedVersion", () => {
  it("takes the fix on the locked version's release line", () => {
    expect(fixedVersion(VULNS.B as never, django)).toBe("4.2.15");
    expect(fixedVersion(VULNS.B as never, { ...django, version: "5.0.1" })).toBe("5.0.8");
    expect(fixedVersion(VULNS.A as never, django)).toBe("4.2.9");
  });

  it("ignores commit ranges", () => {
    const git = { id: "G", affected: [{ package: { name: "django", ecosystem: "PyPI" }, ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: "9f3c1e2" }] }, { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "4.2.16" }] }] }] };
    expect(fixedVersion(git as never, django)).toBe("4.2.16");
  });
});

describe("Go modules", () => {
  it("does not call an indirect requirement a development dependency", () => {
    expect(parseLockfile("go.mod", "module m\n\nrequire (\n\tgolang.org/x/net v0.10.0 // indirect\n)\n")).toEqual([{ ecosystem: "Go", name: "golang.org/x/net", version: "0.10.0", dev: false, source: "go.mod" }]);
  });
});

describe("dependency findings", () => {
  let fixture: FixtureRepo;
  let cacheDir: string;
  beforeAll(async () => {
    fixture = await FixtureRepo.create();
    await fixture.commit({ files: { "go.mod": "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/net v0.10.0 // indirect\n)\n", "main.go": "package main\n\nfunc main() {}\n", "requirements.txt": "django==4.2.5\n", "README.md": "# app\n" }, date: "2026-10-01T00:00:00Z" });
    cacheDir = await mkdtemp(join(tmpdir(), "gitgoblin-cache-"));
  });
  afterAll(async () => {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("names the highest fix across advisories, compared as versions, and keeps indirect Go modules at full value", async () => {
    const github = {
      stats: { requests: 0, remaining: 5000 },
      rest: async (path: string) => {
        if (path === "/repos/o/r") return { owner: { login: "o" }, name: "r", default_branch: "main", description: "d", homepage: null, topics: [], stargazers_count: 1, forks_count: 0, subscribers_count: 0, open_issues_count: 0, license: null, archived: false, disabled: false, fork: false, is_template: false, has_issues: true, size: 1, created_at: "2020-01-01T00:00:00Z", pushed_at: "2026-10-01T00:00:00Z" };
        throw new Error(`not needed: ${path}`);
      },
      graphql: async () => {
        throw new Error("not needed");
      },
    } as unknown as GitHubApi;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("querybatch")) {
        const queries = JSON.parse(String(init?.body)).queries as { package: { name: string } }[];
        return Response.json({ results: queries.map((q) => ({ vulns: q.package.name === "django" ? [{ id: "A" }, { id: "B" }] : q.package.name === "golang.org/x/net" ? [{ id: "GO-1" }] : [] })) });
      }
      const v = VULNS[url.split("/").pop()!];
      return v ? Response.json(v) : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const report = await analyzeRepository({ owner: "o", name: "r", localPath: fixture.dir }, { github, cacheDir, checkLinks: false, dependencyChecks: true, fetchImpl, skipSamples: true, now: new Date("2026-10-29T00:00:00Z") });
    const dep = (name: string) => report.opportunities.find((o) => o.kind === "dependency" && o.title.includes(name));
    expect(dep("django")?.approach[0]).toBe("Bump django to 4.2.15 in the manifest and refresh the lockfile.");
    const net = dep("golang.org/x/net");
    expect(net?.summary).toContain("It is pulled in transitively.");
    expect(net?.summary).not.toContain("development");
    expect(net?.risks.join(" ")).not.toMatch(/Development-only/);
  });
});
