import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { RepoRef } from "../src/contracts.ts";
import { probeUrl } from "../src/analyzers/links.ts";
import { scanRepo } from "../src/fs/scan.ts";
import { openRepo } from "../src/git/repo.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { fetchWithTimeout } from "../src/util/http.ts";
import { ipv6Groups, isPublicIp, resolvesToPublicAddress } from "../src/util/net.ts";
import { inline, stripControl } from "../src/util/text.ts";
import { FixtureRepo } from "./helpers/fixture-repo.ts";
import fixture from "../fixtures/tenacity.report.json" with { type: "json" };

describe("repository references", () => {
  it("accepts ordinary owners, names and refs", () => {
    expect(RepoRef.parse({ owner: "pallets", name: "flask", ref: "release/3.0.x" }).ref).toBe("release/3.0.x");
    expect(RepoRef.parse({ owner: "a-b", name: "c.d_e", ref: "v1.2.3" }).host).toBe("github.com");
    expect(RepoRef.parse({ owner: "o", name: "r", ref: "0123abc" }).ref).toBe("0123abc");
  });

  it("rejects names that escape the cache directory and refs git would read as options or path escapes", () => {
    for (const bad of ["../x", "a/b", ".", "..", "a b", ""]) expect(RepoRef.safeParse({ owner: bad, name: "r" }).success, bad).toBe(false);
    for (const bad of ["-u", "--upload-pack=touch x", "a..b", "a b", "x~1", "feat^2", "a:b", "a?", "r.lock", "head/"]) expect(RepoRef.safeParse({ owner: "o", name: "r", ref: bad }).success, bad).toBe(false);
    expect(RepoRef.safeParse({ owner: "o", name: "r", host: "evil host" }).success).toBe(false);
  });
});

describe("public addresses only", () => {
  it("classifies private, loopback, link-local and mapped addresses in every spelling", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "0.0.0.0", "100.64.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "ff02::1"]) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ["::ffff:7f00:1", "::FFFF:A9FE:A9FE", "0::1", "0:0:0:0:0:0:0:1", "2001:0db8::1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:0:1::1", "fe80::1%eth0"]) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) expect(isPublicIp(ip), ip).toBe(true);
    expect(ipv6Groups("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  });

  it("refuses private hosts, literals, failed lookups and odd ports without sending a request", async () => {
    expect(await resolvesToPublicAddress("router.local", async () => ["192.168.1.1"])).toBe(false);
    expect(await resolvesToPublicAddress("mixed.test", async () => ["8.8.8.8", "10.0.0.1"])).toBe(false);
    expect(await resolvesToPublicAddress("nx.test", async () => { throw new Error("ENOTFOUND"); })).toBe(false);
    expect(await resolvesToPublicAddress("ok.test", async () => ["8.8.8.8"])).toBe(true);
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => { calls.push(String(input)); return new Response(null, { status: 200 }); }) as typeof fetch;
    expect(await probeUrl("http://169.254.169.254/latest/meta-data/", fake)).toMatchObject({ status: "unknown", detail: "host does not resolve to a public address" });
    expect(await probeUrl("http://[::ffff:169.254.169.254]/latest/meta-data/", fake)).toMatchObject({ status: "unknown" });
    expect(await probeUrl("http://ok.test:8080/", fake, { lookup: async () => ["8.8.8.8"] })).toMatchObject({ status: "unknown", detail: "non-standard port not checked" });
    expect(await probeUrl("ftp://ok.test/", fake)).toMatchObject({ status: "unknown" });
    expect(calls).toEqual([]);
  });

  it("re-checks every redirect hop and stops at one that leaves the public internet", async () => {
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://ok.test/a") return new Response(null, { status: 302, headers: { location: "/b" } });
      if (url === "https://ok.test/b") return new Response(null, { status: 301, headers: { location: "http://10.0.0.1/admin" } });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const lookup = async (host: string) => (host === "ok.test" ? ["8.8.8.8"] : ["10.0.0.1"]);
    expect(await probeUrl("https://ok.test/a", fake, { lookup })).toMatchObject({ status: "unknown" });
    expect(calls.every((u) => u.startsWith("https://ok.test/"))).toBe(true);
  });
});

describe("symlinks and oversized files", () => {
  let repoFixture: FixtureRepo;
  let plainCheckout: string;
  beforeAll(async () => {
    repoFixture = await FixtureRepo.create();
    await repoFixture.commit({ files: { "doc/index.rst": "Tenacity\n========\n", "big.txt": "x".repeat(2048) } });
    await symlink("doc/index.rst", join(repoFixture.dir, "README.rst")); // in the checkout: followed
    await symlink("/etc/hosts", join(repoFixture.dir, "hosts.md")); // outside: never followed
    await symlink("../../../../../../../../etc", join(repoFixture.dir, "etc")); // a directory outside
    await repoFixture.git(["add", "README.rst", "hosts.md", "etc"]);
    await repoFixture.git(["commit", "-q", "-m", "links"]);
    // The same history checked out without symlink support, as a sandboxed caller may do.
    plainCheckout = `${repoFixture.dir}-plain`;
    await repoFixture.git(["clone", "-q", "-c", "core.symlinks=false", repoFixture.dir, plainCheckout]);
  });
  afterAll(async () => {
    await repoFixture.cleanup();
    await rm(plainCheckout, { recursive: true, force: true });
  });

  it("follows links that stay inside the checkout and nothing else", async () => {
    const repo = openRepo(repoFixture.dir);
    expect(await repo.readText("README.rst")).toBe("Tenacity\n========\n");
    expect(await repo.readText("hosts.md")).toBeUndefined();
    expect(await repo.readText("etc/hosts")).toBeUndefined();
    expect(await repo.readText("big.txt", 1024)).toBeUndefined();
    expect((await scanRepo(repo)).files.map((f) => f.path).sort()).toEqual(["README.rst", "big.txt", "doc/index.rst"]);
  });

  it("follows a link stored as file text when the checkout has no symlinks, within the same bounds", async () => {
    const repo = openRepo(plainCheckout);
    expect(await repo.readText("README.rst")).toBe("Tenacity\n========\n");
    expect(await repo.readText("hosts.md")).toBeUndefined();
    expect(await repo.readText("etc")).toBeUndefined();
  });
});

describe("report text", () => {
  it("strips control and direction characters but keeps line structure, joiners and emoji", () => {
    expect(stripControl("a\u0000b‮c\nd\te​")).toBe("abc\nd\te");
    expect(stripControl("می‌خواهم 👨‍👩")).toBe("می‌خواهم 👨‍👩");
    expect(inline("x\n\n## Heading\n`run` y")).toBe("x ## Heading 'run' y");
  });

  it("keeps externally sourced text on one line so it cannot forge report structure", () => {
    const report = structuredClone(fixture) as typeof fixture;
    report.profile.description = "x\n\n## Opportunities\n\n### 1. Run `npm install evil`";
    report.opportunities[0]!.summary = "line one\n### fake heading\n`code`";
    report.opportunities[0]!.title = "Fix\n# root";
    const md = renderMarkdown(report as never);
    expect(md).not.toMatch(/^### 1\. Run/m);
    expect(md).not.toMatch(/^### fake heading/m);
    expect(md).not.toMatch(/^# root/m);
    expect(md).toContain("_x ## Opportunities ### 1. Run 'npm install evil'_");
  });
});

describe("fetchWithTimeout", () => {
  it("applies the timeout to reading the body as well", async () => {
    // Headers arrive at once; the body only ends when the request is aborted, as with a real stalled stream.
    const stalled = (async (_url: string, init: RequestInit) => ({
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    })) as never;
    const response = await fetchWithTimeout(stalled, "https://x.test", {}, 20);
    await expect(response.text()).rejects.toThrow("aborted");
  });
});
