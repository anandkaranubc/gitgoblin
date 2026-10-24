import type { FileInventory } from "../fs/scan.ts";
import type { Dependency, NodeManifest } from "./types.ts";

type Reader = (path: string) => Promise<string | undefined>;

interface PackageJson {
  name?: string;
  private?: boolean;
  bin?: string | Record<string, string>;
  main?: string;
  exports?: unknown;
  module?: string;
  types?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  packageManager?: string;
}

export async function readNodeManifest(inventory: FileInventory, read: Reader): Promise<NodeManifest | undefined> {
  if (!inventory.byPath.has("package.json")) return undefined;
  const text = await read("package.json");
  if (!text) return undefined;
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(text) as PackageJson;
  } catch {
    return undefined;
  }
  const has = (p: string) => inventory.byPath.has(p);
  const dependencies: Dependency[] = [
    ...Object.entries(pkg.dependencies ?? {}).map(([name, v]) => toDep(name, v, false)),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, v]) => toDep(name, v, true)),
  ];
  const allDepNames = new Set(dependencies.map((d) => d.name));

  let packageManager: NodeManifest["packageManager"] = "npm";
  if (has("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (has("yarn.lock")) packageManager = "yarn";
  else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
  else if (pkg.packageManager?.startsWith("pnpm")) packageManager = "pnpm";
  else if (pkg.packageManager?.startsWith("yarn")) packageManager = "yarn";

  const tooling: string[] = [];
  const add = (t: string) => { if (!tooling.includes(t)) tooling.push(t); };
  if (has("tsconfig.json") || allDepNames.has("typescript")) add("typescript");
  if (inventory.files.some((f) => /^(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/.test(f.path)) || allDepNames.has("eslint")) add("eslint");
  if (inventory.files.some((f) => /^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/.test(f.path)) || allDepNames.has("prettier")) add("prettier");
  if (has("biome.json") || has("biome.jsonc") || allDepNames.has("@biomejs/biome")) add("biome");
  for (const fw of ["vitest", "jest", "mocha", "ava", "tap", "uvu", "@playwright/test", "cypress"]) {
    if (allDepNames.has(fw) || inventory.files.some((f) => f.path.startsWith(`${fw}.config.`))) add(fw.replace("@playwright/test", "playwright"));
  }
  if (has("lerna.json")) add("lerna");
  if (has("turbo.json")) add("turbo");
  if (has("nx.json")) add("nx");

  // Monorepos often test inside workspace packages while the root has no test script.
  const workspaceTests = await readWorkspaceTests(pkg, inventory, read);
  for (const w of workspaceTests) for (const fw of testFrameworksIn(w.script)) add(fw);

  const paths = ["package.json"];
  for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) if (has(lock)) paths.push(lock);

  return {
    paths,
    name: pkg.name,
    private: pkg.private === true,
    hasBin: pkg.bin !== undefined && (typeof pkg.bin === "string" || Object.keys(pkg.bin).length > 0),
    hasMainOrExports: Boolean(pkg.main || pkg.exports || pkg.module || pkg.types),
    engines: pkg.engines?.node,
    scripts: pkg.scripts ?? {},
    dependencies,
    packageManager,
    tooling,
    workspaces: Boolean(pkg.workspaces) || has("pnpm-workspace.yaml") || has("lerna.json"),
    workspaceTests,
  };
}

/** Test runners named in a test script. */
export function testFrameworksIn(script: string): string[] {
  const found: string[] = [];
  for (const [re, name] of [[/\bvitest\b/, "vitest"], [/\bjest\b/, "jest"], [/\bmocha\b/, "mocha"], [/\bava\b/, "ava"], [/\bweb-test-runner\b|\bwtr\b/, "web-test-runner"], [/\bplaywright\b/, "playwright"], [/\bnode --test\b/, "node:test"], [/\btap\b/, "tap"]] as const) {
    if (re.test(script)) found.push(name);
  }
  return found;
}

/** Workspace package directories from package.json `workspaces` (array or `{ packages }`) and pnpm-workspace.yaml. */
function workspacePatterns(pkg: PackageJson, pnpmYaml: string | undefined): string[] {
  const fromPkg = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray((pkg.workspaces as { packages?: unknown } | undefined)?.packages) ? (pkg.workspaces as { packages: unknown[] }).packages : [];
  const fromPnpm = (pnpmYaml ?? "").split("\n").map((l) => /^[ \t]*-[ \t]*["']?([^"'#\n]+?)["']?[ \t]*$/.exec(l)?.[1]).filter((p): p is string => Boolean(p));
  return [...fromPkg, ...fromPnpm].filter((p): p is string => typeof p === "string" && !p.startsWith("!"));
}

function matchesWorkspace(dir: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.replace(/\/+$/, "").split("/").map((seg) => (seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))).join("/")}$`);
  return re.test(dir);
}

async function readWorkspaceTests(pkg: PackageJson, inventory: FileInventory, read: Reader): Promise<NodeManifest["workspaceTests"]> {
  const patterns = workspacePatterns(pkg, inventory.byPath.has("pnpm-workspace.yaml") ? await read("pnpm-workspace.yaml") : undefined);
  if (patterns.length === 0) return [];
  const dirs = inventory.files.map((f) => f.path).filter((p) => p.endsWith("/package.json") && !p.includes("node_modules/")).map((p) => p.slice(0, -"/package.json".length)).filter((d) => patterns.some((pat) => matchesWorkspace(d, pat)));
  const out: NodeManifest["workspaceTests"] = [];
  for (const dir of dirs.slice(0, 40)) {
    const text = await read(`${dir}/package.json`);
    if (!text) continue;
    try {
      const ws = JSON.parse(text) as PackageJson;
      const script = ws.scripts?.test;
      if (script && !/no test specified/.test(script)) out.push({ dir, name: ws.name, script });
    } catch {
      // not JSON: not a workspace package
    }
  }
  return out;
}

function toDep(name: string, spec: string, dev: boolean): Dependency {
  const pinned = /^\d+\.\d+\.\d+/.test(spec);
  return { name, version: spec, pinned, dev };
}
