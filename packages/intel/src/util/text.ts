import { createHash } from "node:crypto";

/** Stable short id from its inputs, e.g. `ev-3f2a9c1d`. */
export function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha1").update(parts.join("\u0000")).digest("hex");
  return `${prefix}-${hash.slice(0, 8)}`;
}

/**
 * Remove control characters (keeping newlines and tabs), bidi overrides and isolates, zero-width
 * spaces and joiners that carry no text, from text that came from a repository, an issue or a model.
 * ZWJ and ZWNJ (U+200C, U+200D) stay: Persian words and emoji sequences need them.
 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "");
}

/** Externally sourced text on a single line: no control characters, collapsed whitespace, backticks neutralised. */
export function inline(text: string, max = 400): string {
  return truncate(stripControl(text).replace(/`/g, "'"), max);
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

/** Remove any run of the given characters from the end, without a regex (no backtracking on long runs). */
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}
