import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where intel keeps clones and API responses between runs. */
export function defaultCacheDir(): string {
  const fromEnv = process.env.GITGOBLIN_CACHE_DIR;
  if (fromEnv) return fromEnv;
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg ?? join(homedir(), ".cache"), "gitgoblin", "intel");
}

interface Entry<T> {
  storedAt: number;
  value: T;
}

/** Small JSON-on-disk cache with per-read max age. Failures degrade to a miss. */
export class DiskCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async get<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      const entry = JSON.parse(raw) as Entry<T>;
      if (Date.now() - entry.storedAt > maxAgeMs) return undefined;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const entry: Entry<T> = { storedAt: Date.now(), value };
    const path = this.pathFor(key);
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, path);
    } catch {
      // A cache that cannot write is just a slow cache.
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${createHash("sha1").update(key).digest("hex")}.json`);
  }
}
