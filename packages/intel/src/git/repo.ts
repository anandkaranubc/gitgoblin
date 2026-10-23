import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { promisify } from "node:util";

import type { RepoRef } from "../contracts.ts";
import { looksBinary } from "../util/text.ts";

const execFileAsync = promisify(execFile);

export interface Commit {
  sha: string;
  authorEmail: string;
  authorName: string;
  /** ISO 8601 author date. */
  date: string;
  subject: string;
  files: string[];
}

export interface BlameInfo {
  sha: string;
  date: string;
  authorEmail: string;
}

export interface LogOptions {
  since?: string;
  maxCount?: number;
  paths?: string[];
}

/** Read-only view of a local checkout. All paths are repo-relative. */
export interface GitRepo {
  readonly dir: string;
  headSha(): Promise<string>;
  lsFiles(): Promise<string[]>;
  /** Text content, or undefined when missing, binary, or over `maxBytes`. */
  readText(path: string, maxBytes?: number): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  /** Non-merge commits, newest first. Uses `--name-only`, which never fetches blobs. */
  log(options?: LogOptions): Promise<Commit[]>;
  blameLine(path: string, line: number): Promise<BlameInfo | undefined>;
  /** Number of commits touching a path. Tree-only, so cheap even in a blob:none clone. */
  revisionCount(path: string): Promise<number>;
  /** Tracked files under `paths` containing `word` as a whole word, case-insensitive. */
  grep(word: string, paths: string[]): Promise<string[]>;
  /**
   * Files containing `text` exactly (case-sensitive), at HEAD or at `rev`. Searching a past
   * revision fetches the blobs of `paths` in a blob:none clone, so callers keep `paths` short.
   */
  grepExact(text: string, options?: { paths?: string[]; rev?: string }): Promise<string[]>;
  /** The newest commit on the current branch at or before an ISO date. */
  revBefore(dateIso: string): Promise<string | undefined>;
  /** A file's text at a revision, or undefined when missing, binary or over `maxBytes`. One blob fetch in a blob:none clone. */
  showFile(rev: string, path: string, maxBytes?: number): Promise<string | undefined>;
  /** Name of the branch origin/HEAD points at, or the current branch. */
  defaultBranch(): Promise<string>;
  /** Author date of the oldest reachable commit (bounded by clone depth). */
  firstCommitDate(): Promise<string | undefined>;
  /** Tags newest first, with their creation dates. */
  tags(limit?: number): Promise<{ name: string; date: string }[]>;
}

/**
 * A repository path as a regular file inside the checkout: symlinks are followed only while they stay
 * inside it (git checks out a link with any target, so `README.md -> /dev/zero` or `docs -> /` must
 * resolve to nothing), and the `.git` directory is never a target.
 */
export async function resolveInCheckout(dir: string, path: string): Promise<{ real: string; size: number } | undefined> {
  try {
    const root = await realpath(dir);
    const real = await realpath(join(dir, path));
    const inside = relative(root, real);
    if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside) || inside.split(sep)[0] === ".git") return undefined;
    const info = await stat(real);
    return info.isFile() ? { real, size: info.size } : undefined;
  } catch {
    return undefined; // missing, a dangling link, or unreadable
  }
}

/** A minimal environment: no tokens, and no GIT_DIR/GIT_WORK_TREE from a calling hook or alias pointing git at another repository. */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_EXEC_PATH", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT"]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
GIT_ENV.GIT_TERMINAL_PROMPT = "0";
GIT_ENV.LC_ALL = "C";

export async function git(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: GIT_ENV,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export function openRepo(dir: string): GitRepo {
  return new LocalGitRepo(dir);
}

export interface CloneOptions {
  /** Directory that holds one subdirectory per repository. */
  cacheDir: string;
  /** Limit history for very large repositories. */
  depth?: number | undefined;
  timeoutMs?: number;
}

export interface CloneResult {
  repo: GitRepo;
  cloneMs: number;
  /** False when an existing clone was updated instead. */
  fresh: boolean;
}

/** Clone with `--filter=blob:none` (full history, HEAD blobs only), or update an existing clone. */
export async function ensureClone(ref: RepoRef, options: CloneOptions): Promise<CloneResult> {
  const started = Date.now();
  const dir = join(options.cacheDir, "repos", `${ref.owner}__${ref.name}`);
  const url = `https://${ref.host}/${ref.owner}/${ref.name}.git`;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const target = ref.ref ?? "HEAD";

  if (await pathExists(join(dir, ".git"))) {
    await git(["fetch", "--quiet", "--filter=blob:none", "origin", target], dir, timeoutMs);
    await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], dir, timeoutMs);
    return { repo: openRepo(dir), cloneMs: Date.now() - started, fresh: false };
  }

  await mkdir(join(options.cacheDir, "repos"), { recursive: true });
  const args = ["clone", "--quiet", "--filter=blob:none", "--single-branch", "--tags"];
  if (ref.ref) args.push("--branch", ref.ref);
  if (options.depth) args.push("--depth", String(options.depth));
  args.push(url, dir);
  await git(args, options.cacheDir, timeoutMs);
  return { repo: openRepo(dir), cloneMs: Date.now() - started, fresh: true };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const RECORD = "\u001e";
const FIELD = "\u001f";

class LocalGitRepo implements GitRepo {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async headSha(): Promise<string> {
    return (await git(["rev-parse", "HEAD"], this.dir)).trim();
  }

  async lsFiles(): Promise<string[]> {
    const out = await git(["ls-files", "-z"], this.dir);
    return out.split("\0").filter((p) => p.length > 0);
  }

  private linkBlobs: Promise<Set<string>> | undefined;

  /** Paths git records as symlinks (mode 120000), whether or not the checkout made them real links. */
  private symlinkEntries(): Promise<Set<string>> {
    this.linkBlobs ??= git(["ls-files", "-s", "-z"], this.dir)
      .then((out) => new Set(out.split("\0").filter((e) => e.startsWith("120000 ")).map((e) => e.slice(e.indexOf("\t") + 1))))
      .catch(() => new Set<string>());
    return this.linkBlobs;
  }

  /**
   * Follow a path to a regular file inside the checkout. Real symlinks are resolved by the file system;
   * a checkout made with core.symlinks=false stores the link target as file text, which is followed the
   * same way so a symlinked README still reads as the README.
   */
  private async resolveFile(path: string, hops: number): Promise<{ real: string; size: number } | undefined> {
    if (hops > 5) return undefined;
    const file = await resolveInCheckout(this.dir, path);
    if (!file) return undefined;
    if (file.size < 1024 && !(await lstat(join(this.dir, path))).isSymbolicLink() && (await this.symlinkEntries()).has(path)) {
      const target = (await readFile(file.real, "utf8")).trim();
      if (!target || isAbsolute(target)) return undefined;
      const next = posix.normalize(posix.join(posix.dirname(path), target));
      if (next === ".." || next.startsWith("../")) return undefined;
      return this.resolveFile(next, hops + 1);
    }
    return file;
  }

  async readText(path: string, maxBytes = 512 * 1024): Promise<string | undefined> {
    try {
      const file = await this.resolveFile(path, 0);
      if (!file || file.size > maxBytes) return undefined; // the size is checked before reading, never after
      const buf = await readFile(file.real);
      if (looksBinary(buf)) return undefined;
      return buf.toString("utf8");
    } catch {
      return undefined;
    }
  }

  exists(path: string): Promise<boolean> {
    return pathExists(join(this.dir, path));
  }

  async log(options: LogOptions = {}): Promise<Commit[]> {
    const args = [
      "log",
      "--no-merges",
      "--name-only",
      `--format=${RECORD}%H${FIELD}%aE${FIELD}%aN${FIELD}%aI${FIELD}%s`,
    ];
    if (options.since) args.push(`--since=${options.since}`);
    if (options.maxCount) args.push(`--max-count=${options.maxCount}`);
    args.push("--");
    if (options.paths?.length) args.push(...options.paths);
    const out = await git(args, this.dir);
    return parseLog(out);
  }

  async defaultBranch(): Promise<string> {
    try {
      const ref = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], this.dir)).trim();
      if (ref) return ref.replace(/^origin\//, "");
    } catch {
      // No origin/HEAD (local checkout); fall through.
    }
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], this.dir)).trim();
    return branch === "HEAD" ? "main" : branch;
  }

  async firstCommitDate(): Promise<string | undefined> {
    try {
      const out = (await git(["log", "--reverse", "--format=%aI", "--max-parents=0", "HEAD"], this.dir)).trim().split("\n")[0];
      return out || undefined;
    } catch {
      return undefined;
    }
  }

  async tags(limit = 10): Promise<{ name: string; date: string }[]> {
    try {
      const out = await git(["for-each-ref", "--sort=-creatordate", `--count=${limit}`, "--format=%(refname:short)%09%(creatordate:iso-strict)", "refs/tags"], this.dir);
      return out.split("\n").filter((l) => l.includes("\t")).map((l) => { const [name, date] = l.split("\t"); return { name: name!, date: date! }; });
    } catch {
      return [];
    }
  }

  async grep(word: string, paths: string[]): Promise<string[]> {
    try {
      const out = await git(["grep", "-l", "-i", "-w", "-F", "-e", word, "--", ...paths], this.dir, 30_000);
      return out.split("\n").filter((l) => l.length > 0);
    } catch {
      return []; // git grep exits 1 when nothing matches
    }
  }

  async grepExact(text: string, options: { paths?: string[]; rev?: string } = {}): Promise<string[]> {
    const args = ["grep", "-l", "-I", "-F", "-e", text];
    if (options.rev) args.push(options.rev);
    args.push("--", ...(options.paths ?? []));
    try {
      const out = await git(args, this.dir, 30_000);
      return out
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => (options.rev && l.startsWith(`${options.rev}:`) ? l.slice(options.rev.length + 1) : l));
    } catch {
      return [];
    }
  }

  async showFile(rev: string, path: string, maxBytes = 512 * 1024): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("git", ["show", `${rev}:${path}`], { cwd: this.dir, env: GIT_ENV, timeout: 60_000, maxBuffer: maxBytes, encoding: "buffer" });
      if (looksBinary(stdout)) return undefined;
      return stdout.toString("utf8");
    } catch {
      return undefined; // missing path, unknown revision, or larger than maxBytes
    }
  }

  async revBefore(dateIso: string): Promise<string | undefined> {
    try {
      const sha = (await git(["rev-list", "-1", `--before=${dateIso}`, "HEAD"], this.dir, 30_000)).trim();
      return sha || undefined;
    } catch {
      return undefined;
    }
  }

  async revisionCount(path: string): Promise<number> {
    try {
      return Number((await git(["rev-list", "--count", "HEAD", "--", path], this.dir, 30_000)).trim()) || 0;
    } catch {
      return 0;
    }
  }

  async blameLine(path: string, line: number): Promise<BlameInfo | undefined> {
    try {
      const out = await git(
        ["blame", "--porcelain", "--no-textconv", "-L", `${line},${line}`, "--", path],
        this.dir,
        30_000,
      );
      const sha = out.split(" ", 1)[0];
      const time = /^author-time (\d+)$/m.exec(out)?.[1];
      const mail = /^author-mail <(.*)>$/m.exec(out)?.[1];
      if (!sha || !time) return undefined;
      return {
        sha,
        date: new Date(Number(time) * 1000).toISOString(),
        authorEmail: mail ?? "",
      };
    } catch {
      return undefined;
    }
  }
}

export function parseLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of raw.split(RECORD)) {
    if (record.trim().length === 0) continue;
    const [header, ...rest] = record.split("\n");
    const [sha, authorEmail, authorName, date, subject] = (header ?? "").split(FIELD);
    if (!sha || !date) continue;
    commits.push({
      sha,
      authorEmail: authorEmail ?? "",
      authorName: authorName ?? "",
      date,
      subject: subject ?? "",
      files: rest.map((l) => l.trim()).filter((l) => l.length > 0),
    });
  }
  return commits;
}
