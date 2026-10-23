import { execShell, tail } from "./exec.ts";
import type { Check, Commands, DiffStats, Verification } from "./types.ts";

export interface CheckSpec {
  name: string;
  command: string;
}

const ORDER: (keyof Commands)[] = ["typecheck", "lint", "build", "test"];

/** The repository's own checks in a sensible order, plus any extra ones (for example a reproduction test). */
export function checkSpecs(commands: Commands, extra: CheckSpec[] = []): CheckSpec[] {
  const specs: CheckSpec[] = [];
  for (const name of ORDER) {
    const command = commands[name];
    if (command) specs.push({ name, command });
  }
  for (const spec of extra) {
    // A reproduction that is just "run the suite" is already covered by the test check.
    if (spec.command && !specs.some((s) => s.name === spec.name || s.command === spec.command)) specs.push(spec);
  }
  return specs;
}

export interface RunChecksOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  onCheck?: (check: Check) => void;
}

export async function runChecks(specs: CheckSpec[], opts: RunChecksOptions): Promise<Check[]> {
  const checks: Check[] = [];
  for (const spec of specs) {
    const result = await execShell(spec.command, { cwd: opts.cwd, env: opts.env, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    const check: Check = {
      name: spec.name,
      command: spec.command,
      status: result.timedOut ? "timeout" : result.exitCode === 0 ? "pass" : "fail",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputTail: tail(result.output),
    };
    checks.push(check);
    opts.onCheck?.(check);
  }
  return checks;
}

const failed = (c: Check) => c.status === "fail" || c.status === "timeout";

/**
 * Compares a verification run with the baseline taken before any change. A failure that already
 * existed at baseline is reported but does not count against the change; everything else must
 * pass. A baseline timeout tells us nothing, so it never excuses a failure.
 */
export function compareWithBaseline(now: Check[], baseline: Check[] | undefined, diff: DiffStats): Verification {
  const baselineStatus = new Map((baseline ?? []).map((c) => [c.name, c.status]));
  const regressions = now.filter((c) => failed(c) && baselineStatus.get(c.name) === "pass").map((c) => c.name);
  const blocking = now.filter((c) => failed(c) && baselineStatus.get(c.name) !== "fail");
  return { checks: now, regressions, ok: blocking.length === 0, diff };
}

export function describeChecks(checks: Check[]): string {
  return checks.map((c) => `- ${c.name}: ${c.status} (${c.command}, ${Math.round(c.durationMs / 1000)}s)`).join("\n");
}
