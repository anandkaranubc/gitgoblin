import { parse as parseToml } from "smol-toml";

import type { FileInventory } from "../fs/scan.ts";
import type { Dependency, RustManifest } from "./types.ts";

type Reader = (path: string) => Promise<string | undefined>;

export async function readRustManifest(inventory: FileInventory, read: Reader): Promise<RustManifest | undefined> {
  if (!inventory.byPath.has("Cargo.toml")) return undefined;
  const text = await read("Cargo.toml");
  if (!text) return undefined;
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const pkg = rec(data.package);
  const dependencies: Dependency[] = [];
  for (const [section, dev] of [["dependencies", false], ["dev-dependencies", true], ["build-dependencies", true]] as const) {
    for (const [name, spec] of Object.entries(rec(data[section]) ?? {})) {
      const version = typeof spec === "string" ? spec : (rec(spec)?.version as string | undefined);
      dependencies.push({ name, version, pinned: Boolean(version && /^=?\d+\.\d+\.\d+$/.test(version)), dev });
    }
  }
  const tooling = ["cargo"];
  if (inventory.byPath.has("rustfmt.toml") || inventory.byPath.has(".rustfmt.toml")) tooling.push("rustfmt");
  if (inventory.byPath.has("clippy.toml") || inventory.byPath.has(".clippy.toml")) tooling.push("clippy");
  if (inventory.byPath.has("deny.toml")) tooling.push("cargo-deny");
  const paths = ["Cargo.toml"];
  if (inventory.byPath.has("Cargo.lock")) paths.push("Cargo.lock");
  return {
    paths,
    name: typeof pkg?.name === "string" ? pkg.name : undefined,
    edition: typeof pkg?.edition === "string" || typeof pkg?.edition === "number" ? String(pkg.edition) : undefined,
    dependencies,
    hasBin: Array.isArray(data.bin) || inventory.byPath.has("src/main.rs") || inventory.files.some((f) => f.path.startsWith("src/bin/")),
    hasLib: data.lib !== undefined || inventory.byPath.has("src/lib.rs"),
    tooling,
  };
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
