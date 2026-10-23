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

const CHECK_ISOLATIONS: readonly CheckIsolation[] = ["auto", "sandbox", "strict", "none"];

export function parseCheckIsolation(value: string | undefined): CheckIsolation | undefined {
  if (value === undefined) return undefined;
  if ((CHECK_ISOLATIONS as readonly string[]).includes(value)) return value as CheckIsolation;
  throw new Error(`--check-isolation must be one of ${CHECK_ISOLATIONS.join(", ")}, got ${JSON.stringify(value)}`);
}

/** `--clone-depth`: a positive whole number of commits, for very large repositories. */
export function parseCloneDepth(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) throw new Error(`--clone-depth must be a whole number of commits, at least 1, got ${JSON.stringify(value)}`);
  return Number(value);
}

/**
 * `--no-sandbox` runs the agent's commands on this machine with only text-matching hooks in the way.
 * The flag alone is not enough: the environment must also say so, so the choice is deliberate and
 * visible in the shell history of whoever made it.
 */
export function unsandboxedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["GITGOBLIN_UNSAFE_NO_SANDBOX"] === "1";
}

/** `--install-network`: "registries" (the default when an OS sandbox is in use) or "open". */
export function parseInstallNetwork(value: string | undefined): "registries" | "open" | undefined {
  if (value === undefined) return undefined;
  if (value === "registries" || value === "open") return value;
  throw new Error(`--install-network must be registries or open, got ${JSON.stringify(value)}`);
}
