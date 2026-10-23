import { existsSync, mkdirSync, realpathSync } from "node:fs";
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

export async function prepareToolchain(task: Task, wsPath: string, runDir: string, env: Record<string, string>): Promise<Toolchain> {
  // Real path, because interpreters report real paths and sandbox rules match on them.
  mkdirSync(runDir, { recursive: true });
  const root = path.join(realpathSync(runDir), "toolchain");
  const toolchain: Toolchain = { env: {}, writeDirs: [], notes: [] };
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
