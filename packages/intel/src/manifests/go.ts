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
  const lines = requireBlockLines(text);
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

/**
 * The lines inside go.mod's `require ( ... )` blocks. Read line by line: a pattern like
 * `^require\s*\(([^)]*)\)` rescans to the end of the file from every unclosed `require (`.
 */
export function requireBlockLines(text: string): string[] {
  const lines: string[] = [];
  let start = -1; // where the open block's lines begin in `lines`
  for (const line of text.split("\n")) {
    let rest = line;
    if (start < 0) {
      const open = /^require\s*\(/.exec(line);
      if (!open) continue;
      start = lines.length;
      rest = line.slice(open[0].length);
    }
    const close = rest.indexOf(")");
    lines.push(close < 0 ? rest : rest.slice(0, close));
    if (close >= 0) start = -1;
  }
  // A block that never closes is dropped, as before: Go rejects that file.
  if (start >= 0) lines.length = start;
  return lines;
}
