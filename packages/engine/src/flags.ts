import type { Effort } from "./agent.ts";
import type { CheckIsolation } from "./hostbox.ts";

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

const CHECK_ISOLATIONS: readonly CheckIsolation[] = ["auto", "sandbox", "none"];

export function parseCheckIsolation(value: string | undefined): CheckIsolation | undefined {
  if (value === undefined) return undefined;
  if ((CHECK_ISOLATIONS as readonly string[]).includes(value)) return value as CheckIsolation;
  throw new Error(`--check-isolation must be one of ${CHECK_ISOLATIONS.join(", ")}, got ${JSON.stringify(value)}`);
}
