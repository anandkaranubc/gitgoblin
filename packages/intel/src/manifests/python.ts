import { parse as parseToml } from "smol-toml";

import type { FileInventory } from "../fs/scan.ts";
import type { Dependency, PythonManifest } from "./types.ts";

type Reader = (path: string) => Promise<string | undefined>;

const PYTHON_FILES = new Set(["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"]);

/** setup.cfg and tox.ini alone are often just lint or test config in a non-Python project. */
export function hasPythonManifest(inventory: FileInventory): boolean {
  if (inventory.files.some((f) => !f.vendored && PYTHON_FILES.has(f.path))) return true;
  const realCode = (f: { path: string; ext: string; category: string; vendored: boolean }) => !f.vendored && f.ext === ".py" && f.category === "source" && !/(^|\/)(scripts?|tools?|docs?|examples?|debug|ci|misc|utils?)(\/|$)/.test(f.path);
  return inventory.files.some(realCode) && inventory.files.some((f) => f.path === "setup.cfg" || f.path === "tox.ini");
}

export async function readPythonManifest(inventory: FileInventory, read: Reader): Promise<PythonManifest | undefined> {
  const root = (name: string) => inventory.byPath.has(name);
  if (!hasPythonManifest(inventory)) return undefined;

  const manifest: PythonManifest = {
    paths: [],
    name: undefined,
    requiresPython: undefined,
    classifierVersions: [],
    dependencies: [],
    scripts: [],
    packageManager: "pip",
    tooling: [],
    packageDirs: [],
    hasPyTyped: false,
  };

  if (root("pyproject.toml")) {
    manifest.paths.push("pyproject.toml");
    const text = await read("pyproject.toml");
    if (text) applyPyproject(manifest, text);
  }
  if (root("setup.cfg")) {
    const text = await read("setup.cfg");
    // Only a setup.cfg with package metadata is a manifest; one holding just [flake8] is tooling.
    if (text && /^\[(metadata|options)\]/m.test(text)) {
      manifest.paths.push("setup.cfg");
      applySetupCfg(manifest, text);
    } else if (text) {
      if (/^\[flake8\]/m.test(text)) addTool(manifest, "flake8");
      if (/^\[tool:pytest\]/m.test(text)) addTool(manifest, "pytest");
      if (/^\[mypy\]/m.test(text)) addTool(manifest, "mypy");
    }
  }
  if (root("setup.py")) {
    manifest.paths.push("setup.py");
    const text = await read("setup.py");
    if (text) applySetupPy(manifest, text);
  }
  for (const req of inventory.files.filter((f) => /^requirements[\w.-]*\.txt$/.test(f.path))) {
    manifest.paths.push(req.path);
    const text = await read(req.path);
    if (text) manifest.dependencies.push(...parseRequirements(text, /dev|test|lint|doc/i.test(req.path)));
  }

  if (root("uv.lock")) manifest.packageManager = "uv";
  else if (root("poetry.lock")) manifest.packageManager = "poetry";
  else if (root("pdm.lock")) manifest.packageManager = "pdm";
  else if (root("Pipfile") || root("Pipfile.lock")) manifest.packageManager = "pipenv";

  const toolFiles: [string, string][] = [
    ["tox.ini", "tox"], ["noxfile.py", "nox"], ["pytest.ini", "pytest"], ["mypy.ini", "mypy"],
    [".flake8", "flake8"], [".pylintrc", "pylint"], ["pyrightconfig.json", "pyright"],
    [".pre-commit-config.yaml", "pre-commit"], ["ruff.toml", "ruff"], [".ruff.toml", "ruff"],
    ["conftest.py", "pytest"],
  ];
  for (const [file, tool] of toolFiles) if (root(file)) addTool(manifest, tool);
  if (manifest.dependencies.some((d) => d.name === "pytest")) addTool(manifest, "pytest");
  if (inventory.files.some((f) => f.category === "test" && f.ext === ".py") && !manifest.tooling.includes("pytest") && !manifest.tooling.includes("unittest")) {
    // Nearly every modern Python suite is pytest; a config-free suite is still most likely pytest.
    addTool(manifest, "pytest");
  }

  manifest.packageDirs = findPackageDirs(inventory);
  manifest.hasPyTyped = inventory.files.some((f) => f.path.endsWith("/py.typed") || f.path === "py.typed");
  manifest.dependencies = dedupe(manifest.dependencies);
  return manifest;
}

function addTool(m: PythonManifest, tool: string): void {
  if (!m.tooling.includes(tool)) m.tooling.push(tool);
}

function applyPyproject(m: PythonManifest, text: string): void {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const project = asRecord(data.project);
  const tool = asRecord(data.tool);
  const poetry = asRecord(tool?.poetry);

  m.name = str(project?.name) ?? str(poetry?.name) ?? m.name;
  m.requiresPython = str(project?.["requires-python"]) ?? str(asRecord(poetry?.dependencies)?.python) ?? m.requiresPython;
  m.classifierVersions.push(...classifierVersions((arr(project?.classifiers) ?? arr(poetry?.classifiers) ?? []).map(String)));

  for (const dep of arr(project?.dependencies) ?? []) m.dependencies.push(parseRequirement(String(dep), false));
  for (const group of Object.values(asRecord(project?.["optional-dependencies"]) ?? {})) {
    for (const dep of arr(group) ?? []) m.dependencies.push(parseRequirement(String(dep), true));
  }
  for (const [name, spec] of Object.entries(asRecord(poetry?.dependencies) ?? {})) {
    if (name !== "python") m.dependencies.push({ name: normalizeName(name), version: specVersion(spec), pinned: isPinnedSpec(spec), dev: false });
  }
  for (const group of Object.values(asRecord(poetry?.group) ?? {})) {
    for (const [name, spec] of Object.entries(asRecord(asRecord(group)?.dependencies) ?? {})) {
      m.dependencies.push({ name: normalizeName(name), version: specVersion(spec), pinned: isPinnedSpec(spec), dev: true });
    }
  }
  for (const [name, spec] of Object.entries(asRecord(poetry?.["dev-dependencies"]) ?? {})) {
    m.dependencies.push({ name: normalizeName(name), version: specVersion(spec), pinned: isPinnedSpec(spec), dev: true });
  }

  m.scripts.push(...Object.keys(asRecord(project?.scripts) ?? {}), ...Object.keys(asRecord(poetry?.scripts) ?? {}));

  for (const [key, label] of [
    ["ruff", "ruff"], ["black", "black"], ["mypy", "mypy"], ["pyright", "pyright"], ["pytest", "pytest"],
    ["isort", "isort"], ["flake8", "flake8"], ["pylint", "pylint"], ["uv", "uv"], ["pdm", "pdm"],
    ["hatch", "hatch"], ["poetry", "poetry"], ["tox", "tox"], ["coverage", "coverage"],
  ] as const) {
    if (tool && key in tool) addTool(m, label);
  }
  if (poetry && m.packageManager === "pip") m.packageManager = "poetry";
  if (tool?.hatch && m.packageManager === "pip") m.packageManager = "hatch";
  if (tool?.uv && m.packageManager === "pip") m.packageManager = "uv";
}

function applySetupCfg(m: PythonManifest, text: string): void {
  const name = /^\s*name\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (name && !m.name) m.name = name;
  const req = /^\s*python_requires\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (req && !m.requiresPython) m.requiresPython = req;
  m.classifierVersions.push(...classifierVersions(text.split("\n")));
  const block = /^\s*install_requires\s*=\s*\n((?:\s+.+\n?)+)/m.exec(text)?.[1];
  if (block) for (const line of block.split("\n")) if (line.trim()) m.dependencies.push(parseRequirement(line.trim(), false));
  if (/^\[tool:pytest\]/m.test(text)) addTool(m, "pytest");
  if (/^\[flake8\]/m.test(text)) addTool(m, "flake8");
  if (/^\[mypy\]/m.test(text)) addTool(m, "mypy");
  if (/console_scripts/.test(text)) m.scripts.push("(console_scripts in setup.cfg)");
}

function applySetupPy(m: PythonManifest, text: string): void {
  const name = /\bname\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
  if (name && !m.name) m.name = name;
  const req = /python_requires\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
  if (req && !m.requiresPython) m.requiresPython = req;
  m.classifierVersions.push(...classifierVersions(text.split("\n")));
  const block = /install_requires\s*=\s*\[([^\]]*)\]/s.exec(text)?.[1];
  if (block) {
    for (const match of block.matchAll(/["']([^"']+)["']/g)) m.dependencies.push(parseRequirement(match[1]!, false));
  }
  if (/console_scripts/.test(text)) m.scripts.push("(console_scripts in setup.py)");
}

/** Versions from "Programming Language :: Python :: 3.X" classifiers, deduplicated and sorted. */
export function classifierVersions(classifiers: string[]): string[] {
  const versions = new Set<string>();
  for (const c of classifiers) {
    const match = /Programming Language :: Python :: (\d\.\d+)\b/.exec(c);
    if (match) versions.add(match[1]!);
  }
  return [...versions].sort(compareVersions);
}

export function compareVersions(a: string, b: string): number {
  const [aMaj = 0, aMin = 0] = a.split(".").map(Number);
  const [bMaj = 0, bMin = 0] = b.split(".").map(Number);
  return aMaj - bMaj || aMin - bMin;
}

export function parseRequirements(text: string, dev: boolean): Dependency[] {
  const deps: Dependency[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-") || line.startsWith("http") || line.includes("://")) continue;
    deps.push(parseRequirement(line, dev));
  }
  return deps;
}

export function parseRequirement(spec: string, dev: boolean): Dependency {
  const cleaned = spec.split(";")[0]!.trim();
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(cleaned);
  const name = normalizeName(match?.[1] ?? cleaned);
  const rest = (match?.[3] ?? "").trim();
  const pin = /^==\s*([\w.+!-]+)$/.exec(rest);
  return { name, version: pin ? pin[1]! : rest || undefined, pinned: Boolean(pin), dev };
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function specVersion(spec: unknown): string | undefined {
  if (typeof spec === "string") return spec;
  return str(asRecord(spec)?.version);
}

function isPinnedSpec(spec: unknown): boolean {
  const v = specVersion(spec);
  return Boolean(v && /^\d+\.\d+(\.\d+)?$/.test(v));
}

function findPackageDirs(inventory: FileInventory): string[] {
  const dirs = new Set<string>();
  for (const f of inventory.files) {
    if (f.vendored || !f.path.endsWith("/__init__.py")) continue;
    const parts = f.path.split("/");
    if (parts.length === 2) dirs.add(parts[0]!);
    else if (parts.length === 3 && parts[0] === "src") dirs.add(`src/${parts[1]}`);
  }
  // `t` is a common short name for a test tree (celery); it is not a package to document or test.
  return [...dirs].filter((d) => !/^(t|tests?|testing|docs?|examples?|scripts?|benchmarks?|tools?)$/.test(d.replace(/^src\//, "")));
}

function dedupe(deps: Dependency[]): Dependency[] {
  const seen = new Map<string, Dependency>();
  for (const d of deps) if (!seen.has(d.name) || (!d.dev && seen.get(d.name)!.dev)) seen.set(d.name, d);
  return [...seen.values()];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
