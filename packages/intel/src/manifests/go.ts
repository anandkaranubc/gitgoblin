import type { FileInventory } from "../fs/scan.ts";
import type { Dependency, GoManifest } from "./types.ts";

type Reader = (path: string) => Promise<string | undefined>;

export async function readGoManifest(inventory: FileInventory, read: Reader): Promise<GoManifest | undefined> {
  if (!inventory.byPath.has("go.mod")) return undefined;
  const text = await read("go.mod");
  if (!text) return undefined;
  const module = /^module\s+(\S+)/m.exec(text)?.[1];
  const goVersion = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1];
  const dependencies: Dependency[] = [];
  const blocks = text.matchAll(/^require\s*\(([^)]*)\)/gms);
  const lines: string[] = [];
  for (const block of blocks) lines.push(...block[1]!.split("\n"));
  for (const single of text.matchAll(/^require\s+(\S+\s+\S+)/gm)) lines.push(single[1]!);
  for (const raw of lines) {
    const line = raw.trim();
    const match = /^(\S+)\s+(v\S+)/.exec(line);
    if (match) dependencies.push({ name: match[1]!, version: match[2]!, pinned: true, dev: /\/\/\s*indirect/.test(line) });
  }
  const tooling: string[] = ["go"];
  if (inventory.files.some((f) => /^\.golangci\.(ya?ml|toml|json)$/.test(f.path))) tooling.push("golangci-lint");
  if (inventory.byPath.has("Makefile")) tooling.push("make");
  const hasMainPackage =
    inventory.byPath.has("main.go") || inventory.files.some((f) => /^cmd\/[^/]+\/main\.go$/.test(f.path));
  const paths = ["go.mod"];
  if (inventory.byPath.has("go.sum")) paths.push("go.sum");
  return { paths, module, goVersion, dependencies, hasMainPackage, tooling };
}
