import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

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
  const args = ["clone", "--quiet", "--filter=blob:none", "--single-branch"];
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

  async readText(path: string, maxBytes = 512 * 1024): Promise<string | undefined> {
    try {
      const buf = await readFile(join(this.dir, path));
      if (buf.length > maxBytes || looksBinary(buf)) return undefined;
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

  async grep(word: string, paths: string[]): Promise<string[]> {
    try {
      const out = await git(["grep", "-l", "-i", "-w", "-F", "-e", word, "--", ...paths], this.dir, 30_000);
      return out.split("\n").filter((l) => l.length > 0);
    } catch {
      return []; // git grep exits 1 when nothing matches
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
        ["blame", "--porcelain", "-L", `${line},${line}`, "--", path],
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
