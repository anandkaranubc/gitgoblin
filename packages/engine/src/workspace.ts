import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
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

/**
 * Every patch a person, the reviewer or the secret scan reads shows each file's real content. Without
 * these, a `-diff` line in the repository's .gitattributes (or one NUL byte) turns a change into
 * "Binary files differ" that is still committed and pushed, and a textconv driver from the operator's
 * git config could print a summary in place of the content.
 */
export const AS_TEXT = ["--text", "--no-textconv", "--no-ext-diff"];

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

class EmptyRepositoryError extends Error {
  constructor(where: string) {
    super(`${where} has no commits; there is nothing to start a contribution from`);
  }
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
  if (!(await commitExists("HEAD", repo, env))) throw new EmptyRepositoryError(`the checkout at ${repo}`);
  return { ref: "HEAD", note: `origin/${task.repo.defaultBranch} is not available locally; started from the checkout's HEAD` };
}

/**
 * The commit a fresh clone should start from. Profiles can be stale (the commit is gone) or wrong
 * about the default branch (a repository on `master` or `trunk`), and a repository can be empty;
 * each case is either explained in a note or refused in plain words, never a raw git error.
 */
async function resolveCloneStart(task: Task, wsPath: string, env: Record<string, string>): Promise<{ ref: string; note?: string }> {
  const wanted = task.repo.headSha;
  if (wanted && (await commitExists(wanted, wsPath, env))) return { ref: wanted };
  const named = `refs/remotes/origin/${task.repo.defaultBranch}`;
  if (await commitExists(named, wsPath, env)) {
    return wanted ? { ref: named, note: `commit ${wanted.slice(0, 7)} is not in the repository; started from origin/${task.repo.defaultBranch}` } : { ref: named };
  }
  if (await commitExists("refs/remotes/origin/HEAD", wsPath, env)) {
    return { ref: "refs/remotes/origin/HEAD", note: `origin/${task.repo.defaultBranch} is not a branch of the repository; started from its default branch` };
  }
  throw new EmptyRepositoryError(task.repo.cloneUrl ?? `${task.repo.owner}/${task.repo.name}`);
}

/**
 * Creates an isolated checkout for one run: a git worktree when the task points at a local
 * repository (never touching that checkout), otherwise a fresh clone.
 */
export interface WorkspaceOptions {
  /** Shallow clone depth; omitted means full history. Only applies when cloning. */
  cloneDepth?: number;
}

export async function prepareWorkspace(task: Task, runDir: string, env: Record<string, string>, options: WorkspaceOptions = {}): Promise<Workspace> {
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
  const depth = options.cloneDepth ? ["--depth", String(options.cloneDepth), "--no-single-branch"] : [];
  await git(["clone", "--quiet", "--no-tags", ...depth, "--", task.repo.cloneUrl, wsPath], runDir, env, 15 * 60_000);
  const start = await resolveCloneStart(task, wsPath, env);
  await git(["checkout", "--quiet", "-b", branch, start.ref], wsPath, env);
  const baseSha = await git(["rev-parse", "HEAD"], wsPath, env);
  return { path: wsPath, branch, baseSha, source: "clone", ...(start.note ? { startNote: start.note } : {}) };
}

export async function removeWorkspace(ws: Workspace, env: Record<string, string>): Promise<void> {
  if (ws.source === "worktree" && ws.originRepo) {
    await git(["worktree", "remove", "--force", ws.path], ws.originRepo, env).catch(() => undefined);
    await git(["branch", "-D", ws.branch], ws.originRepo, env).catch(() => undefined);
  }
  await rm(ws.path, { recursive: true, force: true });
}

/**
 * What the install step writes into the workspace: installed packages and package-manager stores
 * that land there when the tool cannot reach its usual location. They are the install's output, not
 * the contribution, so the engine never stages changes to them, even in a repository without a
 * .gitignore or one that vendors node_modules (a GitHub Action, say), where they stay as they were at
 * the base commit. `.yarn/cache` is not here: zero-install repositories commit it on purpose.
 */
const STRAY_CACHES = [":(glob)**/node_modules/**", ":(glob)**/.pnpm-store/**", ":(glob)**/.yarn-cache/**"];

/**
 * Stages every change, including new files, so diffs and commits see the same content. Stray tool
 * caches are reset to how they were at the base commit, which also undoes an agent's own
 * `git add -A` or commit of them.
 */
export async function stageAll(wsPath: string, env: Record<string, string>, baseSha?: string): Promise<void> {
  await git(["add", "-A", "--", ".", ...STRAY_CACHES.map((p) => p.replace(":(glob)", ":(exclude,glob)"))], wsPath, env);
  if (baseSha) await git(["reset", "-q", baseSha, "--", ...STRAY_CACHES], wsPath, env).catch(() => undefined);
}

/**
 * What a published run's workspace holds beyond the published commit, in words, or undefined when
 * nothing: changes not committed (install output in STRAY_CACHES aside), and commits after it on HEAD
 * or the run's branch. A workspace git cannot read counts as holding work, so nothing is deleted blind.
 */
export async function unpublishedWork(wsPath: string, commitSha: unknown, branch: string, env: Record<string, string>): Promise<string | undefined> {
  let status: string;
  let ahead = 0;
  try {
    status = await git(["status", "--porcelain", "--", ".", ...STRAY_CACHES.map((p) => p.replace(":(glob)", ":(exclude,glob)"))], wsPath, env);
    if (typeof commitSha === "string") ahead = Number(await git(["rev-list", "--count", "HEAD", branch, `^${commitSha}`], wsPath, env));
  } catch (error) {
    return `a state git could not read (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
  const parts = [ahead > 0 ? `${ahead} commit${ahead === 1 ? "" : "s"} after the published one` : "", status ? "changes that are not committed" : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/**
 * `git diff --numstat` against the base, one entry per path as it is on disk. The gates match these
 * names against control, protected and binary files, so a rename counts as its old and new path
 * (not "a => b") and a non-ASCII or odd name is not C-quoted. The cap is the patch cap, so a huge
 * change is measured and then escalated by the file limit with a readable reason, rather than failing
 * on the size of this listing.
 */
async function numstat(wsPath: string, baseSha: string, env: Record<string, string>): Promise<{ ins: string; del: string; file: string }[]> {
  const out = await git(["diff", "--cached", "--numstat", "-z", "--no-renames", baseSha], wsPath, env, 5 * 60_000, DEFAULT_MAX_PATCH_BYTES);
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [ins = "", del = "", ...rest] = entry.split("\t");
      return { ins, del, file: rest.join("\t") };
    });
}

/**
 * Untracked files the repository ignores, outside the stray caches, that `keep` picks, each with a hash
 * of its content. Staging leaves ignored files out, so a file the agent adds together with a .gitignore
 * line for it (or under a path already ignored) never reaches the diff, while the checks still load it.
 */
export async function ignoredFiles(wsPath: string, env: Record<string, string>, keep: (file: string) => boolean): Promise<Map<string, string>> {
  const listing = await git(["ls-files", "-o", "-i", "--exclude-standard", "-z", "--", ".", ...STRAY_CACHES.map((p) => p.replace(":(glob)", ":(exclude,glob)"))], wsPath, env, 5 * 60_000, DEFAULT_MAX_PATCH_BYTES);
  const files = new Map<string, string>();
  for (const file of listing.split("\0").filter((f) => f && keep(f))) {
    let hash = "unreadable";
    try {
      hash = createHash("sha256").update(readFileSync(path.join(wsPath, file))).digest("hex");
    } catch {}
    files.set(file, hash);
  }
  return files;
}

/** Changes since the run's base commit, whether the agent committed them or not. */
export async function diffStats(wsPath: string, baseSha: string, env: Record<string, string>): Promise<DiffStats> {
  await stageAll(wsPath, env, baseSha);
  const stats: DiffStats = { files: 0, insertions: 0, deletions: 0, changedFiles: [] };
  for (const { ins, del, file } of await numstat(wsPath, baseSha, env)) {
    if (!file) continue;
    stats.files += 1;
    stats.insertions += Number(ins) || 0;
    stats.deletions += Number(del) || 0;
    stats.changedFiles.push(file);
  }
  return stats;
}

/**
 * Changed files whose new content holds a NUL byte: images, archives, compiled output. Nobody can
 * review those as a diff, and a large one would fill the reviewer's whole context.
 */
export async function binaryChanges(wsPath: string, baseSha: string, env: Record<string, string>): Promise<string[]> {
  await stageAll(wsPath, env, baseSha);
  // Without --text, numstat marks files it treats as binary with "-"; a -diff attribute does that to text too.
  const flagged = (await numstat(wsPath, baseSha, env)).filter((e) => e.ins === "-" && e.del === "-").map((e) => e.file);
  return flagged.filter((file) => hasNul(path.join(wsPath, file)));
}

function hasNul(file: string): boolean {
  if (!existsSync(file)) return false; // deleted
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(8000);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

export async function diffPatch(wsPath: string, baseSha: string, env: Record<string, string>, maxBytes = DEFAULT_MAX_PATCH_BYTES): Promise<string> {
  await stageAll(wsPath, env, baseSha);
  return git(["diff", "--cached", ...AS_TEXT, baseSha], wsPath, env, 5 * 60_000, maxBytes);
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
  await stageAll(wsPath, env, baseSha);
  if (!(await hasGitIdentity(wsPath, env))) {
    throw new Error("git user.name and user.email are not configured; commits must carry the operator's identity");
  }
  const args = ["commit", "--quiet", "-m", message];
  if (signoff) args.push("--signoff");
  await git(args, wsPath, env);
  return git(["rev-parse", "HEAD"], wsPath, env);
}
