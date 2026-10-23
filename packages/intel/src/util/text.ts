import { createHash } from "node:crypto";

/** Stable short id from its inputs, e.g. `ev-3f2a9c1d`. */
export function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha1").update(parts.join("\u0000")).digest("hex");
  return `${prefix}-${hash.slice(0, 8)}`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

/** Line number (1-based) of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** True when a buffer looks like binary data (NUL byte in the first 8 KB). */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
