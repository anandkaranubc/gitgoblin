import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { requireBlockLines } from "../manifests/go.ts";

export type OsvEcosystem = "npm" | "PyPI" | "Go" | "crates.io" | "RubyGems" | "Packagist";

export interface LockedPackage {
  ecosystem: OsvEcosystem;
  name: string;
  version: string;
  dev: boolean;
  /** Lockfile or manifest the entry came from. */
  source?: string;
}

/** Parse a lockfile into exact (name, version) pairs. Unknown files return []. */
export function parseLockfile(path: string, text: string): LockedPackage[] {
  return parseLockfileEntries(path, text).map((p) => ({ ...p, source: path }));
}

function parseLockfileEntries(path: string, text: string): LockedPackage[] {
  const name = path.split("/").pop() ?? path;
  try {
    switch (name) {
      case "package-lock.json": return parsePackageLock(text);
      case "pnpm-lock.yaml": return parsePnpmLock(text);
      case "yarn.lock": return parseYarnLock(text);
      case "poetry.lock": return parseTomlPackages(text, "PyPI", (p) => p.category === "dev");
      case "uv.lock": return parseTomlPackages(text, "PyPI", () => false).filter((p) => p.version !== "");
      case "Pipfile.lock": return parsePipfileLock(text);
      case "Cargo.lock": return parseTomlPackages(text, "crates.io", () => false);
      case "Gemfile.lock": return parseGemfileLock(text);
      case "composer.lock": return parseComposerLock(text);
      case "go.mod": return parseGoMod(text);
      default: return [];
    }
  } catch {
    return [];
  }
}

export function dedupePackages(packages: LockedPackage[]): LockedPackage[] {
  const seen = new Map<string, LockedPackage>();
  for (const p of packages) {
    const key = `${p.ecosystem}:${p.name}@${p.version}`;
    const prior = seen.get(key);
    if (!prior || (prior.dev && !p.dev)) seen.set(key, p);
  }
  return [...seen.values()];
}

function parsePackageLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>; dependencies?: Record<string, { version?: string; dev?: boolean }> };
  const out: LockedPackage[] = [];
  if (lock.packages) {
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (!key || pkg.link || !pkg.version) continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue;
      out.push({ ecosystem: "npm", name: key.slice(idx + "node_modules/".length), version: pkg.version, dev: pkg.dev === true });
    }
  } else if (lock.dependencies) {
    for (const [name, dep] of Object.entries(lock.dependencies)) if (dep.version) out.push({ ecosystem: "npm", name, version: dep.version, dev: dep.dev === true });
  }
  return out;
}

function parsePnpmLock(text: string): LockedPackage[] {
  const lock = parseYaml(text) as { packages?: Record<string, { dev?: boolean }> } | null;
  const out: LockedPackage[] = [];
  for (const [key, pkg] of Object.entries(lock?.packages ?? {})) {
    const clean = key.replace(/^\//, "").replace(/\(.*$/, "");
    const at = clean.lastIndexOf("@");
    if (at <= 0) continue;
    out.push({ ecosystem: "npm", name: clean.slice(0, at), version: clean.slice(at + 1), dev: pkg?.dev === true });
  }
  return out;
}

function parseYarnLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let currentName: string | undefined;
  for (const line of text.split("\n")) {
    if (/^[^\s#].*:\s*$/.test(line)) {
      const spec = line.replace(/:\s*$/, "").split(",")[0]!.trim().replace(/^"|"$/g, "");
      const at = spec.lastIndexOf("@");
      currentName = at > 0 ? spec.slice(0, at) : undefined;
    } else if (currentName) {
      const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (v) {
        out.push({ ecosystem: "npm", name: currentName, version: v[1]!, dev: false });
        currentName = undefined;
      }
    }
  }
  return out;
}

function parseTomlPackages(text: string, ecosystem: OsvEcosystem, isDev: (p: Record<string, unknown>) => boolean): LockedPackage[] {
  const data = parseToml(text) as { package?: Record<string, unknown>[] };
  const out: LockedPackage[] = [];
  for (const p of data.package ?? []) {
    const name = p.name;
    const version = p.version;
    if (typeof name !== "string" || typeof version !== "string") continue;
    const source = p.source as { editable?: string; virtual?: string } | undefined;
    if (source?.editable !== undefined || source?.virtual !== undefined) continue; // the project itself (uv)
    out.push({ ecosystem, name: ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name, version, dev: isDev(p) });
  }
  return out;
}

function parsePipfileLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { default?: Record<string, { version?: string }>; develop?: Record<string, { version?: string }> };
  const out: LockedPackage[] = [];
  for (const [section, dev] of [["default", false], ["develop", true]] as const) {
    for (const [name, spec] of Object.entries(lock[section] ?? {})) {
      const version = spec.version?.replace(/^==/, "");
      if (version) out.push({ ecosystem: "PyPI", name: name.toLowerCase().replace(/[-_.]+/g, "-"), version, dev });
    }
  }
  return out;
}

function parseGemfileLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inSpecs = false;
  for (const line of text.split("\n")) {
    if (/^\s{2}specs:/.test(line)) { inSpecs = true; continue; }
    if (/^\S/.test(line)) inSpecs = false;
    if (!inSpecs) continue;
    const m = /^\s{4}(\S+) \(([^)]+)\)/.exec(line);
    if (m) out.push({ ecosystem: "RubyGems", name: m[1]!, version: m[2]!.split("-")[0]!, dev: false });
  }
  return out;
}

function parseComposerLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { packages?: { name: string; version: string }[]; "packages-dev"?: { name: string; version: string }[] };
  const out: LockedPackage[] = [];
  for (const p of lock.packages ?? []) out.push({ ecosystem: "Packagist", name: p.name, version: p.version.replace(/^v/, ""), dev: false });
  for (const p of lock["packages-dev"] ?? []) out.push({ ecosystem: "Packagist", name: p.name, version: p.version.replace(/^v/, ""), dev: true });
  return out;
}

function parseGoMod(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  const lines = requireBlockLines(text);
  for (const single of text.matchAll(/^require\s+(\S+\s+\S+.*)$/gm)) lines.push(single[1]!);
  for (const raw of lines) {
    const m = /^\s*(\S+)\s+v(\S+)/.exec(raw);
    if (m) out.push({ ecosystem: "Go", name: m[1]!, version: m[2]!, dev: /\/\/\s*indirect/.test(raw) });
  }
  return out;
}
