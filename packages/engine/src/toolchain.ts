import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "./exec.ts";
import type { Task } from "./types.ts";

/**
 * A per-run home for what the repository's toolchain installs. The OS sandbox lets repository
 * commands write only to the workspace, the temp directory and tool caches, so an install that
 * targets the interpreter itself (`pip install -e .` into site-packages, `bundle install` into the
 * system gem directory) would fail. Giving those tools a prefix under the run directory keeps the
 * operator's interpreters untouched and makes the install work.
 */
export interface Toolchain {
  /** Environment additions for every repository command and for the agent's shell. */
  env: Record<string, string>;
  /** Directories the sandboxes must allow writes to, beyond the workspace. */
  writeDirs: string[];
  /** What was set up, or why something could not be, for the run log. */
  notes: string[];
}

const PYTHON_RUNNERS = /^(pip3?|python3?|pytest|uv|poetry|tox|nox|hatch|pipenv|ruff|black|mypy|flake8|pylint)$/;
const PYTHON_FILES = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "requirements-dev.txt", "Pipfile", "tox.ini"];

export function looksLikePython(task: Task, wsPath: string): boolean {
  const runners = Object.values(task.commands)
    .filter((c): c is string => Boolean(c))
    .map((c) => c.trim().split(/\s+/)[0] ?? "");
  if (runners.some((r) => PYTHON_RUNNERS.test(path.basename(r)))) return true;
  return PYTHON_FILES.some((f) => existsSync(path.join(wsPath, f)));
}

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

const NODE_RUNNERS = /^(npm|npx|pnpm|yarn|bun|bunx|node|corepack)$/;

/** The package manager a Node project uses, from its manifest, lockfile or commands; undefined for non-Node projects. */
export function nodePackageManager(task: Task, wsPath: string): NodePackageManager | undefined {
  const runners = Object.values(task.commands)
    .filter((c): c is string => Boolean(c))
    .map((c) => path.basename(c.trim().split(/\s+/)[0] ?? ""));
  const manifest = path.join(wsPath, "package.json");
  if (!existsSync(manifest) && !runners.some((r) => NODE_RUNNERS.test(r))) return undefined;
  try {
    const declared = (JSON.parse(readFileSync(manifest, "utf8")) as { packageManager?: unknown }).packageManager;
    const m = typeof declared === "string" ? /^(npm|pnpm|yarn|bun)(@|$)/.exec(declared) : null;
    if (m) return m[1] as NodePackageManager;
  } catch {
    // no manifest or not JSON; fall through
  }
  if (existsSync(path.join(wsPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(wsPath, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(wsPath, "bun.lock")) || existsSync(path.join(wsPath, "bun.lockb"))) return "bun";
  for (const r of runners) {
    if (r === "pnpm") return "pnpm";
    if (r === "yarn") return "yarn";
    if (r === "bun" || r === "bunx") return "bun";
  }
  return "npm";
}

/**
 * Where each package manager keeps its store and caches under the home directory. The sandbox can
 * only allow writes to directories that exist, and a first run on a machine would otherwise fail
 * while the tool tries to create its own home, so they are created up front; this is what the tool
 * itself would do on first use.
 */
function nodeCacheDirs(pm: NodePackageManager, platform: NodeJS.Platform): string[] {
  const darwin = platform === "darwin";
  const corepack = [".cache/node/corepack"];
  switch (pm) {
    case "pnpm":
      return [darwin ? "Library/pnpm" : ".local/share/pnpm", darwin ? "Library/Caches/pnpm" : ".cache/pnpm", ".pnpm-state", ...corepack];
    case "yarn":
      return [darwin ? "Library/Caches/Yarn" : ".cache/yarn", ".yarn", ...corepack];
    case "bun":
      return [".bun/install/cache", ...corepack];
    default:
      return [".npm", ...corepack];
  }
}

export interface ToolchainOptions {
  /** The home directory whose caches are prepared; tests pass a scratch one. */
  home?: string;
}

export async function prepareToolchain(task: Task, wsPath: string, runDir: string, env: Record<string, string>, options: ToolchainOptions = {}): Promise<Toolchain> {
  // Real path, because interpreters report real paths and sandbox rules match on them.
  mkdirSync(runDir, { recursive: true });
  const root = path.join(realpathSync(runDir), "toolchain");
  const toolchain: Toolchain = { env: {}, writeDirs: [], notes: [] };
  const home = options.home ?? os.homedir();

  const pm = nodePackageManager(task, wsPath);
  if (pm) {
    const created: string[] = [];
    for (const rel of nodeCacheDirs(pm, process.platform)) {
      const dir = path.join(home, rel);
      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
          created.push(rel);
        }
      } catch {
        // an unwritable home: the sandbox will refuse the tool's writes and the install log says why
      }
    }
    toolchain.notes.push(`node: ${pm} store and caches under ${home} are writable${created.length ? ` (created ${created.join(", ")})` : ""}`);
  }
  const claim = () => {
    if (!toolchain.writeDirs.includes(root)) {
      mkdirSync(root, { recursive: true });
      toolchain.writeDirs.push(root);
    }
  };

  if (looksLikePython(task, wsPath)) {
    claim();
    const venv = path.join(root, "venv");
    const result = await execFile("python3", ["-m", "venv", venv], { cwd: wsPath, env, timeoutMs: 120_000 });
    if (result.exitCode === 0) {
      const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
      toolchain.env["VIRTUAL_ENV"] = venv;
      toolchain.env["PATH"] = `${bin}${path.delimiter}${env["PATH"] ?? ""}`;
      toolchain.env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1";
      toolchain.env["PIP_REQUIRE_VIRTUALENV"] = "1";
      toolchain.notes.push(`python: virtualenv at ${venv}`);
    } else {
      toolchain.notes.push(`python: could not create a virtualenv (${result.output.trim().split("\n").at(-1) ?? "python3 -m venv failed"}); installs into the interpreter will be refused by the sandbox`);
    }
  }

  if (existsSync(path.join(wsPath, "Gemfile"))) {
    claim();
    toolchain.env["BUNDLE_PATH"] = path.join(root, "bundle");
    toolchain.notes.push(`ruby: BUNDLE_PATH=${toolchain.env["BUNDLE_PATH"]}`);
  }

  return toolchain;
}
