import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCacheDir } from "@gitgoblin/sources";
import { afterAll, describe, expect, it } from "vitest";
import { analysisEnv, mcpCacheDir, pruneClones } from "../src/deps.ts";
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
  it("keeps one directory per forge", () => {
    expect(mcpCacheDir("Codeberg.org", { GITGOBLIN_CACHE_DIR: "/tmp/gg" })).toBe(join("/tmp/gg", "mcp", "codeberg.org"));
    expect(mcpCacheDir("github.com", { GITGOBLIN_CACHE_DIR: "/tmp/gg" })).not.toBe(mcpCacheDir("codeberg.org", { GITGOBLIN_CACHE_DIR: "/tmp/gg" }));
  });

  it("deletes the least recently used clones beyond the limit, never one in use", () => {
    const root = join(scratch, "cache");
    const repos = join(root, "repos");
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(repos, `o__r${i}`), { recursive: true });
      utimesSync(join(repos, `o__r${i}`), 1_000 + i, 1_000 + i);
    }
    const removed = pruneClones(root, 2, new Set([join(repos, "o__r0")]));
    expect(removed.sort()).toEqual([join(repos, "o__r1"), join(repos, "o__r2")]);
    expect(existsSync(join(repos, "o__r0"))).toBe(true);
    expect(existsSync(join(repos, "o__r4"))).toBe(true);
    expect(pruneClones(join(scratch, "missing"), 2, new Set())).toEqual([]);
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
