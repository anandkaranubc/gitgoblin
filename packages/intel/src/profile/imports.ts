import { dirname, posix } from "node:path";

import type { FileInventory } from "../fs/scan.ts";

type Reader = (path: string, maxBytes?: number) => Promise<string | undefined>;

export interface CentralFile {
  path: string;
  importedBy: number;
}

const MAX_FILES = 3000;
/** Not part of the product's own module graph. */
const PERIPHERAL = /(^|\/)(examples?|samples?|docs?|benchmarks?|scripts?|tests?|__tests__|spec|testdata|fixtures|playground|e2e)(\/|$)/;
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * In-degree of the internal import graph for Python, JavaScript/TypeScript, Go
 * and Rust. Regex-based and resolution-light on purpose: it only needs to rank
 * modules, not to be a compiler.
 */
export async function centralFiles(inventory: FileInventory, read: Reader, goModule: string | undefined, limit = 10): Promise<{ files: CentralFile[]; truncated: boolean }> {
  const sources = inventory.files.filter((f) => !f.vendored && f.category === "source" && !PERIPHERAL.test(f.path) && /\.(py|[cm]?[jt]sx?|go|rs)$/.test(f.path) && f.sizeBytes <= 200 * 1024);
  const truncated = sources.length > MAX_FILES;
  const paths = new Set(inventory.files.map((f) => f.path));
  const inDegree = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (to === from || PERIPHERAL.test(to)) return;
    const set = inDegree.get(to) ?? new Set<string>();
    set.add(from);
    inDegree.set(to, set);
  };

  for (const file of sources.slice(0, MAX_FILES)) {
    const text = await read(file.path, 200 * 1024);
    if (!text) continue;
    if (file.path.endsWith(".py")) for (const t of pythonTargets(file.path, text, paths)) link(file.path, t);
    else if (file.path.endsWith(".go")) for (const t of goTargets(file.path, text, goModule, paths)) link(dirname(file.path), t);
    else if (file.path.endsWith(".rs")) for (const t of rustTargets(file.path, text, paths)) link(file.path, t);
    else for (const t of jsTargets(file.path, text, paths)) link(file.path, t);
  }
  const files = [...inDegree.entries()]
    .map(([path, from]) => ({ path, importedBy: from.size }))
    .filter((f) => f.importedBy >= 2)
    .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
    .slice(0, limit);
  return { files, truncated };
}

/** Candidate repo paths for a dotted Python module, trying src/ layouts and packages. */
export function pythonTargets(fromPath: string, text: string, paths: Set<string>): string[] {
  const out = new Set<string>();
  const fromDir = dirname(fromPath);
  for (const m of text.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b|import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*))/gm)) {
    const modules = m[1] ? [m[1]] : (m[2] ?? "").split(",").map((s) => s.trim().split(/[ \t]{1,20}as[ \t]{1,20}/)[0]!);
    for (const mod of modules) {
      let base: string;
      let rest: string;
      if (mod.startsWith(".")) {
        const ups = mod.match(/^\.+/)![0].length - 1;
        base = ups === 0 ? fromDir : fromDir.split("/").slice(0, -ups).join("/");
        rest = mod.slice(ups + 1).replace(/\./g, "/");
      } else {
        base = "";
        rest = mod.replace(/\./g, "/");
      }
      const joined = [base, rest].filter((s) => s.length > 0).join("/");
      const candidates = [joined, `src/${joined}`].flatMap((c) => [`${c}.py`, `${c}/__init__.py`]);
      const hit = candidates.find((c) => paths.has(c));
      if (hit) out.add(hit);
      else {
        // from pkg.sub import name: `name` may itself be a module file.
        const parent = joined.split("/").slice(0, -1).join("/");
        const maybe = [`${parent}.py`, `src/${parent}.py`, `${parent}/__init__.py`, `src/${parent}/__init__.py`].find((c) => parent && paths.has(c));
        if (maybe) out.add(maybe);
      }
    }
  }
  return [...out];
}

export function jsTargets(fromPath: string, text: string, paths: Set<string>): string[] {
  const out = new Set<string>();
  const fromDir = dirname(fromPath);
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const spec = posix.normalize(posix.join(fromDir, m[1]!)).replace(/\.js$/, "");
    const candidates = [spec, ...JS_EXTS.map((e) => `${spec}${e}`), ...JS_EXTS.map((e) => `${spec}/index${e}`), `${spec}.js`];
    const hit = candidates.find((c) => paths.has(c));
    if (hit) out.add(hit);
  }
  return [...out];
}

export function goTargets(fromPath: string, text: string, goModule: string | undefined, paths: Set<string>): string[] {
  if (!goModule) return [];
  const out = new Set<string>();
  const dirs = new Set([...paths].filter((p) => p.endsWith(".go")).map((p) => dirname(p)));
  for (const m of text.matchAll(/"([^"\n]+)"/g)) {
    const imp = m[1]!;
    if (!imp.startsWith(`${goModule}/`) && imp !== goModule) continue;
    const dir = imp === goModule ? "." : imp.slice(goModule.length + 1);
    if (dirs.has(dir) && dir !== dirname(fromPath)) out.add(dir);
  }
  return [...out];
}

export function rustTargets(fromPath: string, text: string, paths: Set<string>): string[] {
  const out = new Set<string>();
  const crateRoot = fromPath.replace(/\/src\/.*$/, "/src").replace(/^src\/.*$/, "src");
  for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)\n]{0,40}\))?[ \t]+)?(?:use[ \t]+crate::([\w:]+)|mod[ \t]+(\w+)[ \t]*;)/gm)) {
    const segments = m[1] ? m[1].split("::").filter((s) => s !== "self" && s !== "super" && !/^[A-Z{*]/.test(s)) : [m[2]!];
    const candidates: string[] = [];
    if (m[2]) candidates.push(`${dirname(fromPath)}/${m[2]}.rs`, `${dirname(fromPath)}/${m[2]}/mod.rs`);
    for (let i = segments.length; i >= 1; i--) {
      const sub = segments.slice(0, i).join("/");
      candidates.push(`${crateRoot}/${sub}.rs`, `${crateRoot}/${sub}/mod.rs`);
    }
    const hit = candidates.find((c) => paths.has(c));
    if (hit && hit !== fromPath) out.add(hit);
  }
  return [...out];
}
