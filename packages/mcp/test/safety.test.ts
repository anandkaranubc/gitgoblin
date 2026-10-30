import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDirFor } from "@gitgoblin/intel";
import { defaultCacheDir } from "@gitgoblin/sources";
import { afterAll, describe, expect, it } from "vitest";
import { analysisEnv, mcpCacheDir, pruneClones, removeLegacyClones, withCloneLock } from "../src/deps.ts";
import { ANALYSIS_HOSTS, capDeep, capText, DISCOVERY_HOSTS, MAX_RESULT_CHARS, stripControl, stripControlDeep } from "../src/safety.ts";

const scratch = mkdtempSync(join(tmpdir(), "gitgoblin-mcp-safety-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("hosts", () => {
  it("discovers on GitHub and analyzes on a fixed set of public forges", () => {
    expect([...DISCOVERY_HOSTS]).toEqual(["github.com"]);
    expect([...ANALYSIS_HOSTS]).toEqual(["github.com", "gitlab.com", "codeberg.org"]);
  });
});

describe("analysisEnv", () => {
  const home = join(scratch, "home");
  mkdirSync(join(home, ".config"), { recursive: true });

  it("gives the child an empty home, the resolved token, and none of git's environment config", () => {
    const env = analysisEnv({ PATH: "/bin", HOME: "/Users/me", GH_TOKEN: "gh", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "x.y", GIT_CONFIG_VALUE_0: "z" }, home, "resolved");
    expect(env).toMatchObject({ PATH: "/bin", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), GITHUB_TOKEN: "resolved" });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_"))).toEqual([]);
    // The HTTP cache stays where the command line keeps it, so the empty home costs no cache misses.
    expect(env.GITGOBLIN_CACHE_DIR).toBe(defaultCacheDir({ HOME: "/Users/me" }));
    expect(analysisEnv({ GITHUB_TOKEN: "stale" }, home, undefined).GITHUB_TOKEN).toBeUndefined();
  });

  it("leaves git with no global configuration: no credential helper, filter or alias of the person's", () => {
    const realHome = join(scratch, "real-home");
    mkdirSync(realHome, { recursive: true });
    writeFileSync(join(realHome, ".gitconfig"), "[credential]\n\thelper = store\n[filter \"lfs\"]\n\tsmudge = git-lfs smudge -- %f\n");
    const run = (env: NodeJS.ProcessEnv) => spawnSync("git", ["config", "--global", "--list"], { env, encoding: "utf8" }).stdout;
    expect(run({ ...process.env, HOME: realHome, XDG_CONFIG_HOME: join(realHome, ".config") })).toContain("credential.helper=store");
    expect(run(analysisEnv({ ...process.env, HOME: realHome }, home, undefined))).toBe("");
  });
});

describe("clone cache", () => {
  it("keeps the server's clones apart from the command line's, keyed by forge by intel", () => {
    expect(mcpCacheDir({ GITGOBLIN_CACHE_DIR: "/tmp/gg" })).toBe(join("/tmp/gg", "mcp"));
    const root = mcpCacheDir({ GITGOBLIN_CACHE_DIR: "/tmp/gg" });
    expect(cloneDirFor(root, { host: "codeberg.org", owner: "o", name: "r" })).not.toBe(cloneDirFor(root, { host: "github.com", owner: "o", name: "r" }));
  });

  it("deletes one forge's least recently used clones beyond the limit, never one an analysis holds", () => {
    const root = join(scratch, "cache");
    const clone = (host: string, owner: string, name: string) => cloneDirFor(root, { host, owner, name });
    for (let i = 0; i < 5; i++) {
      mkdirSync(clone("github.com", `o${i % 2}`, `r${i}`), { recursive: true });
      utimesSync(clone("github.com", `o${i % 2}`, `r${i}`), 1_000 + i, 1_000 + i);
    }
    mkdirSync(clone("codeberg.org", "o", "old"), { recursive: true });
    utimesSync(clone("codeberg.org", "o", "old"), 1, 1);
    writeFileSync(`${clone("github.com", "o0", "r0")}.lock`, "1");
    const removed = pruneClones(root, "github.com", 2);
    expect(removed.sort()).toEqual([clone("github.com", "o1", "r1"), clone("github.com", "o0", "r2")].sort());
    expect(existsSync(clone("github.com", "o0", "r0"))).toBe(true);
    expect(existsSync(clone("github.com", "o0", "r4"))).toBe(true);
    expect(existsSync(clone("codeberg.org", "o", "old"))).toBe(true);
    expect(pruneClones(join(scratch, "missing"), "github.com", 2)).toEqual([]);
  });
});

describe("clone lock", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("runs one analysis of a repository at a time, and different repositories side by side", async () => {
    const root = join(scratch, "locks");
    const active = new Map<string, number>();
    let peakSame = 0;
    let peakAll = 0;
    const analysis = (clone: string) =>
      withCloneLock(clone, async () => {
        active.set(clone, (active.get(clone) ?? 0) + 1);
        peakSame = Math.max(peakSame, active.get(clone) ?? 0);
        peakAll = Math.max(peakAll, [...active.values()].reduce((a, b) => a + b, 0));
        await sleep(60);
        active.set(clone, (active.get(clone) ?? 1) - 1);
      }, undefined, 10);
    const a = join(root, "repos", "github.com", "o", "a");
    const b = join(root, "repos", "github.com", "o", "b");
    await Promise.all([analysis(a), analysis(a), analysis(a), analysis(b)]);
    expect(peakSame).toBe(1);
    expect(peakAll).toBe(2);
    expect(existsSync(`${a}.lock`)).toBe(false);
  });

  it("takes over a lock whose process is gone, and stops waiting when the client cancels", async () => {
    const clone = join(scratch, "locks", "repos", "github.com", "o", "c");
    mkdirSync(join(clone, ".."), { recursive: true });
    const gone = spawn(process.execPath, ["-e", ""]);
    await once(gone, "exit");
    writeFileSync(`${clone}.lock`, String(gone.pid));
    expect(await withCloneLock(clone, async () => "ran", undefined, 10)).toBe("ran");

    writeFileSync(`${clone}.lock`, String(process.pid));
    const controller = new AbortController();
    let ran = false;
    const waiting = withCloneLock(clone, async () => (ran = true), controller.signal, 10);
    await sleep(50);
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled by the client/);
    expect(ran).toBe(false);
    expect(readFileSync(`${clone}.lock`, "utf8")).toBe(String(process.pid));
  });
});

describe("legacy clones", () => {
  it("deletes clones left in earlier layouts and keeps the current ones", () => {
    const root = join(scratch, "legacy");
    mkdirSync(join(root, "repos", "dnkl__foot", "src"), { recursive: true });
    mkdirSync(join(root, "github.com", "repos", "jd__tenacity"), { recursive: true });
    const current = cloneDirFor(root, { host: "github.com", owner: "jd", name: "tenacity" });
    mkdirSync(current, { recursive: true });
    const removed = removeLegacyClones(root, ["github.com", "gitlab.com", "codeberg.org"]);
    expect(removed.sort()).toEqual([join(root, "github.com"), join(root, "repos", "dnkl__foot")].sort());
    expect(existsSync(current)).toBe(true);
    expect(removeLegacyClones(join(scratch, "nothing-here"), ["github.com"])).toEqual([]);
  });
});

describe("stripControl", () => {
  it("removes terminal escapes, bidirectional overrides, zero-width and tag characters but keeps lines and tabs", () => {
    const hidden = "\u{E0049}\u{E0047}\u{E004E}"; // invisible tag characters spelling "IGN"
    expect(stripControl(`a\u001b[31mred\u001b[0m\tb\nc‮evil\u0007 z​w‍j⁠﻿؜${hidden}`)).toBe("a[31mred[0m\tb\ncevil zwj");
    expect(stripControlDeep({ list: ["x\u0000y"], n: 3, nested: { s: "\u009bz" } })).toEqual({ list: ["xy"], n: 3, nested: { s: "z" } });
  });
});

describe("caps", () => {
  it("cuts long text at a line and says how much was left out", () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    const capped = capText(long);
    expect(capped.length).toBeLessThan(MAX_RESULT_CHARS + 100);
    expect(capped).toMatch(/\[result cut: \d+ more characters left out\]$/);
    expect(capText("short")).toBe("short");
  });

  it("caps strings and lists inside structured content", () => {
    const capped = capDeep({ files: Array.from({ length: 40_000 }, (_, i) => `.cursor/rules/${i}.mdc`), body: "x".repeat(10_000) });
    expect(capped.files).toHaveLength(50);
    expect(capped.body.length).toBe(2_000);
  });
});
