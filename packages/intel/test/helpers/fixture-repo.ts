import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FixtureCommit {
  files: Record<string, string>;
  message?: string;
  author?: { name: string; email: string };
  /** ISO date; defaults to now. */
  date?: string;
}

/** A throwaway git repository for tests. Call `cleanup()` when done. */
export class FixtureRepo {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async create(): Promise<FixtureRepo> {
    const dir = await mkdtemp(join(tmpdir(), "gitgoblin-fixture-"));
    const repo = new FixtureRepo(dir);
    await repo.git(["init", "-q", "-b", "main"]);
    await repo.git(["config", "user.name", "Fixture"]);
    await repo.git(["config", "user.email", "fixture@example.com"]);
    await repo.git(["config", "commit.gpgsign", "false"]);
    return repo;
  }

  async commit(spec: FixtureCommit): Promise<string> {
    for (const [path, content] of Object.entries(spec.files)) {
      await mkdir(dirname(join(this.dir, path)), { recursive: true });
      await writeFile(join(this.dir, path), content);
    }
    await this.git(["add", "-A"]);
    const author = spec.author ?? { name: "Fixture", email: "fixture@example.com" };
    const date = spec.date ?? new Date().toISOString();
    await this.git(["commit", "-q", "--allow-empty", "-m", spec.message ?? "update"], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async git(args: string[], env: Record<string, string> = {}): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.dir,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
