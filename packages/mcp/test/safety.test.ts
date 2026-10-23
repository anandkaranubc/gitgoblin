import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mcpCacheDir } from "../src/deps.ts";
import { allowedHosts, hardenGitEnvironment, stripControl, stripControlDeep } from "../src/safety.ts";

const scratch = mkdtempSync(join(tmpdir(), "gitgoblin-mcp-safety-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function hardened(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_")) delete env[key];
  hardenGitEnvironment(env);
  return env;
}

describe("hardenGitEnvironment", () => {
  it("appends its settings after the person's own environment config", () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Ada" };
    hardenGitEnvironment(env);
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_KEY_1).toBe("core.symlinks");
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
    expect(env.GIT_CONFIG_COUNT).toBe("4");
  });

  it("makes git check a committed symlink out as a plain file holding its target", () => {
    const repo = join(scratch, "symlink");
    const plain = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q", repo], { env: plain });
    writeFileSync(join(scratch, "secret.txt"), "do not read me\n");
    symlinkSync("../secret.txt", join(repo, "README.md"));
    execFileSync("git", ["-C", repo, "add", "README.md"], { env: plain });
    execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "link"], { env: plain });
    rmSync(join(repo, "README.md"));

    execFileSync("git", ["-C", repo, "checkout", "--", "README.md"], { env: hardened() });

    expect(lstatSync(join(repo, "README.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("../secret.txt");
  });

  it("refuses clones over anything but HTTPS", () => {
    const source = join(scratch, "source");
    execFileSync("git", ["init", "-q", source]);
    const result = spawnSync("git", ["clone", "-q", `file://${source}`, join(scratch, "copy")], { env: hardened(), encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not allowed/);
  });
});

describe("allowedHosts", () => {
  it("reads GitHub alone, whatever the environment says", () => {
    process.env.GITGOBLIN_MCP_HOSTS = "gitlab.com";
    try {
      expect([...allowedHosts()]).toEqual(["github.com"]);
    } finally {
      delete process.env.GITGOBLIN_MCP_HOSTS;
    }
  });
});

describe("stripControl", () => {
  it("removes terminal escapes and bidirectional overrides but keeps lines and tabs", () => {
    expect(stripControl("a\u001b[31mred\u001b[0m\tb\nc‮evil\u0007")).toBe("a[31mred[0m\tb\ncevil");
    expect(stripControlDeep({ list: ["x\u0000y"], n: 3, nested: { s: "\u009bz" } })).toEqual({ list: ["xy"], n: 3, nested: { s: "z" } });
  });
});

describe("startup", () => {
  it("hardens git before anything else loads", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const firstImport = main.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./env.ts";');
  });

  it("keeps the server's clones apart from the command line's", () => {
    expect(mcpCacheDir({ GITGOBLIN_CACHE_DIR: "/tmp/gg" })).toBe(join("/tmp/gg", "mcp"));
  });
});
