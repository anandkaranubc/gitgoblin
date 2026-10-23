import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "./exec.ts";
import { branchNameFor } from "./naming.ts";
import type { DiffStats, Task } from "./types.ts";

export interface Workspace {
  path: string;
  branch: string;
  /** Commit the branch started from. */
  baseSha: string;
  source: "clone" | "worktree";
  /** Repository the worktree was created from, when `source` is "worktree". */
  originRepo?: string;
  /** Set when the start commit was not the one the task asked for. */
  startNote?: string;
}

export class GitError extends Error {
  readonly args: string[];
  readonly output: string;
  /** True when the command succeeded but produced more output than the caller allowed. */
  readonly exceeded: boolean;

  constructor(args: string[], output: string, exceeded = false) {
    super(exceeded ? `git ${args.join(" ")} produced more output than allowed; output exceeded the cap` : `git ${args.join(" ")} failed: ${output.trim().split("\n").slice(-3).join(" | ")}`);
    this.args = args;
    this.output = output;
    this.exceeded = exceeded;
  }
}

/** Patches larger than this are escalated rather than reviewed; a reviewer cannot read them anyway. */
export const DEFAULT_MAX_PATCH_BYTES = 32 * 1024 * 1024;

/**
 * The agent can edit the workspace, so the engine never lets repository-local git configuration
 * run code on the host: hooks and the filesystem monitor are disabled on every engine git call.
 */
const HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export async function git(args: string[], cwd: string, env: Record<string, string>, timeoutMs = 5 * 60_000, maxOutputBytes?: number): Promise<string> {
  const result = await execFile("git", [...HARDENING, ...args], { cwd, env, timeoutMs, ...(maxOutputBytes ? { maxOutputBytes } : {}) });
  if (result.exitCode !== 0) throw new GitError(args, result.output);
  // A silently truncated diff would hide the start of the patch from the reviewer and the secret scan.
  if (result.truncated) throw new GitError(args, result.output, true);
  return result.output.trimEnd();
}

async function commitExists(ref: string, repo: string, env: Record<string, string>): Promise<boolean> {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo, env).then(() => true, () => false);
}

/** Earlier runs on the same checkout keep their branches, so a new run takes the next free name. */
async function unusedBranchName(branch: string, repo: string, env: Record<string, string>): Promise<string> {
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? branch : `${branch}-${n}`;
    if (!(await commitExists(`refs/heads/${candidate}`, repo, env))) return candidate;
  }
  throw new Error(`too many branches named ${branch}`);
}

/** The commit a worktree should start from: the profiled SHA, else the remote default branch, else HEAD. */
async function resolveStart(task: Task, repo: string, env: Record<string, string>): Promise<{ ref: string; note?: string }> {
  if (task.repo.headSha && (await commitExists(task.repo.headSha, repo, env))) return { ref: task.repo.headSha };
  const remote = `refs/remotes/origin/${task.repo.defaultBranch}`;
  if (await commitExists(remote, repo, env)) {
    return task.repo.headSha
      ? { ref: remote, note: `commit ${task.repo.headSha.slice(0, 7)} is not in the local checkout; started from origin/${task.repo.defaultBranch}` }
      : { ref: remote };
  }
  return { ref: "HEAD", note: `origin/${task.repo.defaultBranch} is not available locally; started from the checkout's HEAD` };
}

/**
 * Creates an isolated checkout for one run: a git worktree when the task points at a local
 * repository (never touching that checkout), otherwise a fresh clone.
 */
export async function prepareWorkspace(task: Task, runDir: string, env: Record<string, string>): Promise<Workspace> {
  const wsPath = path.join(runDir, "workspace");
  const branch = branchNameFor(task);
  await mkdir(runDir, { recursive: true });
  if (existsSync(wsPath)) throw new Error(`workspace already exists: ${wsPath}`);

  if (task.repo.localPath) {
    const origin = path.resolve(task.repo.localPath);
    const start = await resolveStart(task, origin, env);
    const name = await unusedBranchName(branch, origin, env);
    await git(["worktree", "add", "-b", name, wsPath, start.ref], origin, env);
    const baseSha = await git(["rev-parse", "HEAD"], wsPath, env);
    return { path: wsPath, branch: name, baseSha, source: "worktree", originRepo: origin, ...(start.note ? { startNote: start.note } : {}) };
  }

  if (!task.repo.cloneUrl) throw new Error("task has neither repo.localPath nor repo.cloneUrl");
  await git(["clone", "--quiet", "--no-tags", task.repo.cloneUrl, wsPath], runDir, env, 15 * 60_000);
  const start = task.repo.headSha ?? `origin/${task.repo.defaultBranch}`;
  await git(["checkout", "--quiet", "-b", branch, start], wsPath, env);
  const baseSha = await git(["rev-parse", "HEAD"], wsPath, env);
  return { path: wsPath, branch, baseSha, source: "clone" };
}

export async function removeWorkspace(ws: Workspace, env: Record<string, string>): Promise<void> {
  if (ws.source === "worktree" && ws.originRepo) {
    await git(["worktree", "remove", "--force", ws.path], ws.originRepo, env).catch(() => undefined);
    await git(["branch", "-D", ws.branch], ws.originRepo, env).catch(() => undefined);
  }
  await rm(ws.path, { recursive: true, force: true });
}

/** Stages every change, including new files, so diffs and commits see the same content. */
export async function stageAll(wsPath: string, env: Record<string, string>): Promise<void> {
  await git(["add", "-A"], wsPath, env);
}

/** Changes since the run's base commit, whether the agent committed them or not. */
export async function diffStats(wsPath: string, baseSha: string, env: Record<string, string>): Promise<DiffStats> {
  await stageAll(wsPath, env);
  const numstat = await git(["diff", "--cached", "--numstat", baseSha], wsPath, env);
  const stats: DiffStats = { files: 0, insertions: 0, deletions: 0, changedFiles: [] };
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [ins, del, file] = line.split("\t");
    if (!file) continue;
    stats.files += 1;
    stats.insertions += Number(ins) || 0;
    stats.deletions += Number(del) || 0;
    stats.changedFiles.push(file);
  }
  return stats;
}

export async function diffPatch(wsPath: string, baseSha: string, env: Record<string, string>, maxBytes = DEFAULT_MAX_PATCH_BYTES): Promise<string> {
  await stageAll(wsPath, env);
  return git(["diff", "--cached", baseSha], wsPath, env, 5 * 60_000, maxBytes);
}

/** Content of `file` at `sha`, or undefined when it did not exist there. */
export async function showAtBase(wsPath: string, sha: string, file: string, env: Record<string, string>): Promise<string | undefined> {
  const result = await execFile("git", [...HARDENING, "show", `${sha}:${file}`], { cwd: wsPath, env, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024 });
  return result.exitCode === 0 ? result.output : undefined;
}

export async function hasGitIdentity(wsPath: string, env: Record<string, string>): Promise<boolean> {
  const name = await git(["config", "user.name"], wsPath, env).catch(() => "");
  const email = await git(["config", "user.email"], wsPath, env).catch(() => "");
  return Boolean(name && email);
}

/**
 * Squashes everything since `baseSha` into one commit with the engine's message. Agents sometimes
 * commit as they go; the pull request still carries exactly one well-formed commit.
 */
export async function commitAll(wsPath: string, baseSha: string, message: string, env: Record<string, string>, signoff = false): Promise<string> {
  await git(["reset", "--quiet", "--soft", baseSha], wsPath, env);
  await stageAll(wsPath, env);
  if (!(await hasGitIdentity(wsPath, env))) {
    throw new Error("git user.name and user.email are not configured; commits must carry the operator's identity");
  }
  const args = ["commit", "--quiet", "-m", message];
  if (signoff) args.push("--signoff");
  await git(args, wsPath, env);
  return git(["rev-parse", "HEAD"], wsPath, env);
}
