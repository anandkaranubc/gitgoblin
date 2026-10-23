import { type FileEntry, type FileInventory, categorize, isVendored, languageOf } from "../../src/fs/scan.ts";

/** Build an inventory from a path list (or path to size map) without touching disk. */
export function inventoryOf(paths: string[] | Record<string, number>): FileInventory {
  const entries = Array.isArray(paths) ? paths.map((p) => [p, 100] as const) : Object.entries(paths);
  const files: FileEntry[] = entries.map(([path, sizeBytes]) => ({
    path,
    ext: path.includes(".") ? `.${path.split(".").pop()!.toLowerCase()}` : "",
    language: languageOf(path),
    sizeBytes,
    category: categorize(path),
    vendored: isVendored(path),
  }));
  return { files, totalCount: files.length, truncated: false, byPath: new Map(files.map((f) => [f.path, f])) };
}

export function reader(contents: Record<string, string>): (path: string) => Promise<string | undefined> {
  return async (path) => contents[path];
}
