import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";

// `join` builds file-system paths; repository paths are POSIX on every OS.
const { basename, extname } = posix;

import { type GitRepo, resolveInCheckout } from "../git/repo.ts";
import { mapLimit } from "../util/limit.ts";

export type FileCategory = "source" | "test" | "docs" | "config" | "ci" | "other";

export interface FileEntry {
  path: string;
  ext: string;
  language: string | undefined;
  sizeBytes: number;
  category: FileCategory;
  /** Third-party, generated or minified; analyzers ignore these. */
  vendored: boolean;
}

export interface FileInventory {
  files: FileEntry[];
  /** Total paths in the repository before any cap. */
  totalCount: number;
  truncated: boolean;
  byPath: Map<string, FileEntry>;
}

export const MAX_INVENTORY = 50_000;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".py": "Python", ".pyi": "Python",
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "TypeScript",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".scala": "Scala",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#", ".fs": "F#",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++",
  ".swift": "Swift", ".m": "Objective-C",
  ".dart": "Dart",
  ".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang",
  ".hs": "Haskell", ".ml": "OCaml", ".clj": "Clojure", ".lua": "Lua", ".r": "R", ".jl": "Julia",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".ps1": "PowerShell",
  ".vue": "Vue", ".svelte": "Svelte",
  ".md": "Markdown", ".rst": "reStructuredText", ".txt": "Text", ".adoc": "AsciiDoc",
  ".yml": "YAML", ".yaml": "YAML", ".json": "JSON", ".toml": "TOML", ".xml": "XML",
  ".html": "HTML", ".css": "CSS", ".scss": "SCSS",
  ".sql": "SQL", ".proto": "Protocol Buffer", ".tf": "HCL",
};

const DOC_EXT = new Set([".md", ".rst", ".txt", ".adoc", ".mdx"]);
const CONFIG_EXT = new Set([".yml", ".yaml", ".json", ".toml", ".ini", ".cfg", ".xml", ".lock"]);

const VENDORED_SEGMENTS = new Set([
  "node_modules", "vendor", "vendors", "vendored", "_vendor", "_vendored", "third_party", "third-party", "thirdparty", "3rdparty", "external", "extern", "externals",
  "dist", "build", "out", "target", "bin", "obj", ".venv", "venv", "site-packages", "__pycache__",
  "bower_components", "jspm_packages", ".yarn", "generated", "gen", "_build", "deps",
]);
const VENDORED_FILE = /(\.min\.(js|css)|\.bundle\.js|\.pb\.go|_pb2\.py|\.generated\.\w+|\.g\.dart|\.snap)$/i;
const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "Pipfile.lock",
  "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", "flake.lock",
]);

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|testing|e2e|integration-tests?)(\/|$)/i;
const TEST_FILE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go|rs|rb|ex|exs)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+Tests?\.(java|kt|cs|swift|scala)|[^/]+_spec\.rb|conftest\.py)$/;
const DOCS_DIR = /(^|\/)(docs?|documentation|doc-src|wiki|site|website\/docs)(\/|$)/;

export function languageOf(path: string): string | undefined {
  return LANGUAGE_BY_EXT[extname(path).toLowerCase()];
}

/** Grammar and schema sources whose compiled output sits next to them (flex, bison, ANTLR, re2c, Ragel, protobuf). */
const GRAMMAR_EXT = [".l", ".ll", ".lex", ".y", ".yy", ".g4", ".re", ".rl", ".proto"];
const GENERATED_FROM_GRAMMAR = /\.(c|cc|cpp|cxx|h|hh|hpp|go|py|java|rs|ts|js)$/;

/** `src/lexer.c` beside `src/lexer.l` is flex output: edits belong in the grammar, so analyzers treat it as vendored. */
export function markGeneratedBySiblings(files: FileEntry[], all: Set<string>): void {
  for (const f of files) {
    if (f.vendored || !GENERATED_FROM_GRAMMAR.test(f.path)) continue;
    const stem = f.path.replace(/(\.pb)?\.[^./]+$/, "").replace(/_pb2$/, "");
    if (GRAMMAR_EXT.some((ext) => all.has(`${stem}${ext}`))) f.vendored = true;
  }
}

export function isVendored(path: string): boolean {
  if (VENDORED_FILE.test(path)) return true;
  const parts = path.split("/");
  // The final segment is a file name; only directories count as vendored.
  return parts.slice(0, -1).some((segment) => VENDORED_SEGMENTS.has(segment.toLowerCase()));
}

export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

/** A test by its own name (foo.test.ts, test_foo.py), as opposed to a fixture that merely lives under tests/. */
export function isTestSpecFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function isDocsPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (DOCS_DIR.test(path) && (DOC_EXT.has(ext) || ext === ".html" || ext === ".ipynb")) return true;
  if (!path.includes("/") && DOC_EXT.has(ext)) return true; // top-level README, CONTRIBUTING, ...
  return false;
}

export function isCiPath(path: string): boolean {
  return (
    path.startsWith(".github/workflows/") ||
    path === ".gitlab-ci.yml" ||
    path === ".travis.yml" ||
    path === "azure-pipelines.yml" ||
    path === "Jenkinsfile" ||
    path.startsWith(".circleci/")
  );
}

export function categorize(path: string): FileCategory {
  if (isCiPath(path)) return "ci";
  if (isTestPath(path)) return "test";
  if (isDocsPath(path)) return "docs";
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  if (LOCKFILES.has(name) || CONFIG_EXT.has(ext) || name.startsWith(".")) return "config";
  const language = languageOf(path);
  if (language && !DOC_EXT.has(ext)) return "source";
  return "other";
}

/** Inventory the checkout: categories, languages, sizes, and vendored flags. */
export async function scanRepo(repo: GitRepo, maxFiles = MAX_INVENTORY): Promise<FileInventory> {
  const paths = await repo.lsFiles();
  const truncated = paths.length > maxFiles;
  const selected = truncated ? prioritize(paths, maxFiles) : paths;
  const entries = await mapLimit(selected, 64, async (path): Promise<FileEntry | undefined> => {
    let sizeBytes = 0;
    try {
      const info = await lstat(join(repo.dir, path));
      if (info.isSymbolicLink()) {
        // A link to another file in the checkout (a README pointing into docs/) is content; anything else is not.
        const target = await resolveInCheckout(repo.dir, path);
        if (!target) return undefined;
        sizeBytes = target.size;
      } else {
        sizeBytes = info.size;
      }
    } catch {
      // Submodule entries have no file; keep the path.
    }
    return {
      path,
      ext: extname(path).toLowerCase(),
      language: languageOf(path),
      sizeBytes,
      category: categorize(path),
      vendored: isVendored(path),
    };
  });
  const files = entries.filter((e): e is FileEntry => e !== undefined);
  markGeneratedBySiblings(files, new Set(paths));
  return { files, totalCount: paths.length, truncated, byPath: new Map(files.map((f) => [f.path, f])) };
}

/** Keep docs, CI, config and tests first, then source by shallowest path, when over the cap. */
function prioritize(paths: string[], maxFiles: number): string[] {
  const rank = (p: string): number => {
    const c = categorize(p);
    if (c === "ci" || c === "config") return 0;
    if (c === "docs") return 1;
    if (c === "test") return 2;
    if (isVendored(p)) return 5;
    return 3 + Math.min(p.split("/").length / 20, 1);
  };
  return [...paths].sort((a, b) => rank(a) - rank(b)).slice(0, maxFiles);
}
