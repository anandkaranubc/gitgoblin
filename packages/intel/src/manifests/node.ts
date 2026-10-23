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
  };
}

function toDep(name: string, spec: string, dev: boolean): Dependency {
  const pinned = /^\d+\.\d+\.\d+/.test(spec);
  return { name, version: spec, pinned, dev };
}
