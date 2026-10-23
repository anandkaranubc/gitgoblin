import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, diffPatch, diffStats, git, GitError, prepareWorkspace, removeWorkspace } from "../src/workspace.ts";
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
  it("slugifies", () => expect(slugify("Fix Off-by-one in paginate()!")).toBe("fix-off-by-one-in-paginate"));
  it("derives a branch from the task", () => {
    const task = TaskSchema.parse({ id: "x", repo: { owner: "o", name: "n" }, title: "Fix off-by-one in paginate()", issue: { number: 42 }, kind: "issue" });
    expect(branchNameFor(task)).toBe("gitgoblin/fix-42-fix-off-by-one-in-paginate");
    expect(branchNameFor({ ...task, issue: undefined, kind: "docs_drift" })).toBe("gitgoblin/docs-fix-off-by-one-in-paginate");
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
