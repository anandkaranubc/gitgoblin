import { styleText } from "node:util";
import type { ChangePlan, RunResult } from "@gitgoblin/engine";
import type { AnalysisReport, ContributionOpportunity } from "@gitgoblin/intel";
import type { Style } from "./format.ts";

/** How the person named the opportunity they want: an issue number, or an id or rank from the list. */
export interface Choice {
  issue?: string | undefined;
  opportunity?: string | undefined;
}

/**
 * Why the engine would stop at intake, in words a person can act on. Mirrors the engine's intake
 * gate (`atIntake` in packages/engine/src/policy.ts) so nobody pays for a run that cannot start.
 */
export function engineWillRefuse(o: ContributionOpportunity): string | undefined {
  if (o.issue?.inFlight) return `someone is already working on #${o.issue.number} (an assignee or an open pull request)`;
  if (o.kind === "triage") return "needs a reply on the issue, not a patch";
  if (o.kind === "stale_pr") return "continuing someone's pull request needs the original author's consent first; ask on the pull request before running the engine";
  if (o.kind === "hygiene" && o.files.length === 0) return "names no files; it may be a request to the maintainers rather than a change";
  return undefined;
}

/** The first opportunity the engine would accept, else the first one. 1-based, for the prompt. */
export function recommendedRank(report: AnalysisReport): number {
  const index = report.opportunities.findIndex((o) => engineWillRefuse(o) === undefined);
  return index === -1 ? 1 : index + 1;
}

export function formatOpportunities(report: AnalysisReport, style: Style): string {
  const paint = (tone: "bold" | "dim" | "yellow", text: string) => (style.color ? styleText(tone, text) : text);
  const repo = `${report.profile.repo.owner}/${report.profile.repo.name}`;
  if (report.opportunities.length === 0) return `No contribution opportunities found in ${repo}.`;
  const blocks = report.opportunities.map((o, index) => {
    const lines = [`${String(index + 1).padStart(2)}. ${paint("bold", o.title)}`];
    lines.push(`    ${paint("dim", `${o.kind} · score ${o.score.toFixed(2)} · ${o.effort} effort · id ${o.id}`)}`);
    if (o.summary) lines.push(`    ${oneLine(o.summary, 180)}`);
    const evidence = o.evidence[0];
    if (evidence) lines.push(`    ${paint("dim", `evidence: ${evidence.locator}${o.evidence.length > 1 ? ` and ${o.evidence.length - 1} more` : ""}`)}`);
    const refusal = engineWillRefuse(o);
    if (refusal) lines.push(`    ${paint("yellow", "!")} ${refusal}`);
    return lines.join("\n");
  });
  const footer = report.skipped.length > 0 ? `\n\n${paint("dim", `${report.skipped.length} more findings were dropped; the analyze report lists them under Skipped.`)}` : "";
  return `Opportunities in ${repo}, best first:\n\n${blocks.join("\n")}${footer}`;
}

/**
 * Resolves the person's choice to one opportunity. Returns undefined when there is more than one and
 * nothing was chosen, so the caller can ask. Throws with the alternatives when a choice matches nothing.
 */
export function selectOpportunity(report: AnalysisReport, choice: Choice): ContributionOpportunity | undefined {
  const all = report.opportunities;
  const byIssue = (number: string): ContributionOpportunity => {
    const found = all.find((o) => o.issue !== undefined && String(o.issue.number) === number);
    if (!found) throw new Error(`No opportunity for issue #${number}. Available: ${all.map(label).join("; ")}`);
    return found;
  };
  if (choice.issue !== undefined) return byIssue(choice.issue.replace(/^#/, ""));
  if (choice.opportunity !== undefined) {
    const wanted = choice.opportunity.trim();
    if (/^#\d+$/.test(wanted)) return byIssue(wanted.slice(1));
    if (/^\d+$/.test(wanted)) {
      const rank = Number(wanted);
      const found = all[rank - 1];
      if (!found) throw new Error(`There is no opportunity ${rank}; pick a rank between 1 and ${all.length}, or an id.`);
      return found;
    }
    const found = all.find((o) => o.id.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new Error(`No opportunity "${wanted}". Available: ${all.map((o) => `${o.id} (${o.title})`).join("; ")}`);
    return found;
  }
  return all.length === 1 ? all[0] : undefined;
}

/** Collapses whitespace and cuts at `max` characters; the list is for choosing, the report for reading. */
function oneLine(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function label(o: ContributionOpportunity): string {
  return o.issue ? `#${o.issue.number} ${o.title}` : o.title;
}

/** The engine's plan, for the person to approve before anything is implemented. */
export function formatPlan(plan: ChangePlan): string {
  const lines = [`Plan: ${plan.goal}`, ...plan.steps.map((step, index) => `  ${index + 1}. ${step}`)];
  const files = plan.filesToModify.join(", ");
  const created = plan.filesToCreate.join(", ");
  if (files || created) lines.push(`Files: ${[files, created ? `new: ${created}` : ""].filter(Boolean).join("; ")}`);
  if (plan.testsToAdd.length) lines.push(`Tests: ${plan.testsToAdd.join("; ")}`);
  if (plan.outOfScope.length) lines.push(`Out of scope: ${plan.outOfScope.join("; ")}`);
  if (plan.risks.length) lines.push(`Risks: ${plan.risks.join("; ")}`);
  if (plan.needsNewDependency) lines.push("This plan adds a new dependency, which is usually a maintainer decision.");
  return lines.join("\n");
}

/** The reason's first sentence, cut at a word past `max`; the run report carries the whole text. */
function firstSentence(reason: string, max = 200): string {
  const boundary = /[.;](?=\s)/.exec(reason);
  let head = boundary && boundary.index < max ? reason.slice(0, boundary.index + (reason[boundary.index] === "." ? 1 : 0)) : reason;
  if (head.length > max) head = `${head.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return head.length < reason.length ? `${head} (the report below has the rest)` : head;
}

/** The lines a person reads first when a run ends: what happened, what it cost, where the artifacts are. */
export function describeRun(result: RunResult): string[] {
  const lines = [`Run ${result.status}: ${firstSentence(result.reason)}`, `Cost: $${result.costUsd.toFixed(2)} in ${Math.round(result.durationMs / 1000)}s`, `Run directory: ${result.runDir}`];
  for (const question of result.questions) lines.push(`Question for you: ${question}`);
  return lines;
}
