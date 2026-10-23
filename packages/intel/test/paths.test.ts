import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRelativeLink } from "../src/analyzers/links.ts";

const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
});

/**
 * Repository paths are POSIX on every OS. node:path's default exports follow the host, so on Windows
 * `normalize("docs/guide.md")` is "docs\\guide.md" and every relative link looked broken. Only the git
 * wrapper and the inventory build file-system paths, and they may import the OS functions they use.
 */
describe("repository paths stay POSIX", () => {
  const OS_ONLY = new Set(["git/repo.ts", "fs/scan.ts", "util/cache.ts", "index.ts", "analyzers/issues.ts"]);
  it("no module takes path functions from node:path's host-dependent exports, except file-system code", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      const m = /import \{([^}]*)\} from "node:path";/.exec(readFileSync(file, "utf8"));
      if (!m) continue;
      const names = m[1]!.split(",").map((n) => n.trim()).filter(Boolean);
      const hostDependent = names.filter((n) => !["posix", "join", "sep", "isAbsolute", "relative"].includes(n));
      const fsNames = names.filter((n) => ["join", "sep", "isAbsolute", "relative"].includes(n));
      if (hostDependent.length || (fsNames.length && !OS_ONLY.has(rel))) offenders.push(`${rel}: ${names.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("resolves a relative docs link to a POSIX path", async () => {
    const check = await checkRelativeLink({ path: "README.md", line: 1, target: "docs/guide.md#setup", text: "guide" }, (p) => p === "docs/guide.md", () => false, async () => "# Guide\n\n## Setup\n", false);
    expect(check).toBeUndefined();
  });
});
