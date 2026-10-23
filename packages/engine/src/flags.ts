import type { Effort } from "./agent.ts";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** `--max-cost`: a finite positive number of dollars. Anything else would silently remove the limit. */
export function parseCostLimit(value: string): number {
  const n = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || !Number.isFinite(n) || n <= 0) {
    throw new Error(`--max-cost must be a positive number of USD, got ${JSON.stringify(value)}`);
  }
  return n;
}

export function parseEffort(value: string | undefined): Effort | undefined {
  if (value === undefined) return undefined;
  if ((EFFORTS as readonly string[]).includes(value)) return value as Effort;
  throw new Error(`--effort must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(value)}`);
}
