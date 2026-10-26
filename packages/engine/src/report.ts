import type { ImplementationNotes, Investigation, Review, RunResult, Task, Verification } from "./types.ts";
import { forMaintainers } from "./deliver.ts";
import { describeChecks } from "./verify.ts";

const forMaintainersLine = (line: string) => forMaintainers([line]).length === 1;

export interface PhaseSummary {
  name: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  ok: boolean;
  denials: number;
}

export interface ReportInput {
  result: RunResult;
  task: Task;
  phases: PhaseSummary[];
  investigation?: Investigation;
  verification?: Verification;
  review?: Review;
  prTitle?: string;
  /** How the repository's own commands were isolated on this machine: sandbox-exec, bwrap or none. */
  checkIsolation?: string;
  /** Tracked files the install rewrote and the engine put back as committed. */
  installRestored?: string[];
  /** Things about the environment the person should know, such as missing test browsers. */
  setupNotes?: string[];
  /** The last implementation's notes; their environment notes appear here and never in the pull request. */
  notes?: ImplementationNotes;
}

/** Human-readable summary written at the end of every run, whatever its outcome. */
export function renderReport(input: ReportInput): string {
  const { result, task, phases } = input;
  const lines = [
    `# gitgoblin run ${result.runId}`,
    "",
    `- Task: ${task.title} (${task.repo.owner}/${task.repo.name}${task.issue ? `, issue #${task.issue.number}` : ""})`,
    `- Status: **${result.status}**${result.reason ? ` — ${result.reason}` : ""}`,
    `- Cost: $${result.costUsd.toFixed(2)}, ${Math.round(result.durationMs / 1000)}s`,
    result.branch ? `- Branch: ${result.branch}` : "",
    result.workspace ? `- Workspace: ${result.workspace}` : "",
    input.checkIsolation ? `- Repository commands ran ${input.checkIsolation === "none" ? "without an OS sandbox" : `under ${input.checkIsolation}`}` : "",
    input.installRestored?.length ? `- The install rewrote ${input.installRestored.join(", ")}; restored, the change is measured against the committed files` : "",
    ...(input.setupNotes ?? []).map((note) => `- Note: ${note}`),
    "",
  ];
  if (result.questions.length) {
    lines.push("## Questions for a human", ...result.questions.map((q) => `- ${q}`), "");
  }
  if (phases.length) {
    lines.push("## Phases", "| Phase | Result | Turns | Cost | Time | Denied tool calls |", "|---|---|---|---|---|---|");
    for (const p of phases) {
      lines.push(`| ${p.name} | ${p.ok ? "ok" : "failed"} | ${p.turns} | $${p.costUsd.toFixed(2)} | ${Math.round(p.durationMs / 1000)}s | ${p.denials} |`);
    }
    lines.push("");
  }
  if (input.investigation) {
    const inv = input.investigation;
    lines.push("## Investigation", inv.summary, "");
    if (inv.rootCause) lines.push(`Root cause: ${inv.rootCause}`, "");
    if (inv.reproduction.kind !== "none") lines.push(`Reproduction (${inv.reproduction.kind}): \`${inv.reproduction.command || inv.reproduction.path}\` — ${inv.reproduction.observed}`, "");
  }
  if (input.verification) {
    lines.push("## Verification", describeChecks(input.verification.checks));
    lines.push(input.verification.regressions.length ? `Regressions: ${input.verification.regressions.join(", ")}` : "No regressions versus baseline.");
    lines.push("Each check's whole output is in the run directory: check-baseline-<check>.txt and check-verify-<n>-<check>.txt.", "");
  }
  if (input.review) {
    lines.push(`## Review: ${input.review.verdict}`);
    for (const c of input.review.checks) lines.push(`- ${c.name}: ${c.verdict} — ${c.evidence}`);
    for (const f of input.review.findings) lines.push(`- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.summary}`);
    lines.push("");
  }
  const environment = [...(input.notes?.environmentNotes ?? []), ...(input.notes ? [...input.notes.knownGaps, ...input.notes.deviationsFromPlan].filter((line) => !forMaintainersLine(line)) : [])];
  if (environment.length) {
    lines.push("## Environment notes (for you, not in the pull request)", ...environment.map((e) => `- ${e}`), "");
  }
  if (result.status === "awaiting_approval") {
    lines.push("## Next step", "Nothing has been pushed. Read pr.md and diff.patch in this directory; if you would open this pull request by hand, publish it from the tool you ran this with.", "");
  }
  return lines.filter((l) => l !== undefined).join("\n");
}
