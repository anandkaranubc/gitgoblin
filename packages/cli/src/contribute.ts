import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { styleText } from "node:util";
import type { ChangePlan, RunResult } from "@gitgoblin/engine";
import type { AnalysisReport, ContributionOpportunity, RepositoryProfile } from "@gitgoblin/intel";
import type { Style } from "./format.ts";
import { plain } from "./text.ts";

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
  // The agent works offline, so it cannot regenerate a lockfile; checks would run against the old one.
  if (o.kind === "dependency") return "updating a locked dependency needs the lockfile regenerated with network access, which the agent does not have; the repository's dependency bot or a maintainer can run the update";
  return undefined;
}

/**
 * Intel's confidence that a finding is real, below which its main risk is worth a line in the list.
 * Across real reports nearly every finding sits at 0.6 or above; the ones below are those intel has
 * a specific reason to doubt, such as an issue whose quoted code is gone from the default branch.
 */
const DOUBT = 0.5;

/** The risk to show when intel doubts a finding, else undefined. */
export function doubtAbout(o: ContributionOpportunity): string | undefined {
  const confidence = o.factors.find((f) => f.name === "confidence")?.score;
  return confidence !== undefined && confidence < DOUBT ? o.risks[0] : undefined;
}

/** The first opportunity the engine would accept and intel does not doubt, then the first it would accept, else the first. 1-based, for the prompt. */
export function recommendedRank(report: AnalysisReport): number {
  const all = report.opportunities;
  const accepted = (o: ContributionOpportunity) => engineWillRefuse(o) === undefined;
  let index = all.findIndex((o) => accepted(o) && doubtAbout(o) === undefined);
  if (index === -1) index = all.findIndex(accepted);
  return index === -1 ? 1 : index + 1;
}

export function formatOpportunities(report: AnalysisReport, style: Style): string {
  const paint = (tone: "bold" | "dim" | "yellow", text: string) => (style.color ? styleText(tone, text) : text);
  const repo = `${report.profile.repo.owner}/${report.profile.repo.name}`;
  const gap = issueGap(report);
  if (report.opportunities.length === 0) return `No contribution opportunities found in ${repo}.${gap ? ` ${gap}` : ""}`;
  const blocks = report.opportunities.map((o, index) => {
    const lines = [`${String(index + 1).padStart(2)}. ${paint("bold", plain(o.title))}`];
    lines.push(`    ${paint("dim", `${o.kind} · score ${o.score.toFixed(2)} · ${o.effort} effort · id ${o.id}`)}`);
    if (o.summary) lines.push(`    ${oneLine(o.summary, 180)}`);
    const evidence = o.evidence[0];
    if (evidence) lines.push(`    ${paint("dim", `evidence: ${plain(evidence.locator)}${o.evidence.length > 1 ? ` and ${o.evidence.length - 1} more` : ""}`)}`);
    const doubt = doubtAbout(o);
    if (doubt) lines.push(`    ${paint("yellow", "?")} ${oneLine(doubt, 180)}`);
    const refusal = engineWillRefuse(o);
    if (refusal) lines.push(`    ${paint("yellow", "!")} ${refusal}`);
    return lines.join("\n");
  });
  const footer = report.skipped.length > 0 ? `\n\n${paint("dim", `${report.skipped.length} more findings were dropped; the analyze report lists them under Skipped.`)}` : "";
  const warning = gap ? `${paint("yellow", "!")} ${gap}\n\n` : "";
  return `${warning}Opportunities in ${repo}, best first:\n\n${blocks.join("\n")}${footer}`;
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
    if (!found) throw new Error(`No opportunity "${plain(wanted)}". Available: ${all.map((o) => `${o.id} (${plain(o.title)})`).join("; ")}`);
    return found;
  }
  return all.length === 1 ? all[0] : undefined;
}

/** Collapses whitespace and cuts at `max` characters; the list is for choosing, the report for reading. */
function oneLine(text: string, max: number): string {
  const clean = plain(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function label(o: ContributionOpportunity): string {
  return plain(o.issue ? `#${o.issue.number} ${o.title}` : o.title);
}

/** The engine's plan, for the person to approve before anything is implemented. */
export function formatPlan(input: ChangePlan): string {
  // The plan is model output; keep the terminal safe from anything it echoed from the repository.
  const clean = (values: string[]) => values.map(plain);
  const plan = { ...input, goal: plain(input.goal), steps: clean(input.steps), filesToModify: clean(input.filesToModify), filesToCreate: clean(input.filesToCreate), testsToAdd: clean(input.testsToAdd), outOfScope: clean(input.outOfScope), risks: clean(input.risks) };
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
  const lines = [`Run ${result.status}: ${firstSentence(plain(result.reason))}`, `Cost: $${result.costUsd.toFixed(2)} in ${Math.round(result.durationMs / 1000)}s`, `Run directory: ${result.runDir}`];
  for (const question of result.questions) lines.push(`Question for you: ${plain(question)}`);
  return lines;
}

/**
 * What the engine knows about the environment when it asks for plan approval: the install step and
 * the baseline checks. Declared loosely here, the way the engine projects intel's types, so the CLI
 * reads only the fields it shows and older engines that pass nothing still work.
 */
export interface PlanContextLike {
  /** exitCode is null when the install was killed or timed out. */
  install?: { exitCode: number | null; logPath: string } | undefined;
  baseline?: { name: string; status: string }[] | undefined;
}

/** A warning for the plan question when a change implemented now could not be verified properly. */
export function describeEnvironment(context: PlanContextLike | undefined): string | undefined {
  if (!context) return undefined;
  const installFailed = context.install !== undefined && context.install.exitCode !== 0;
  const failing = (context.baseline ?? []).filter((check) => check.status !== "pass").map((check) => plain(check.name));
  if (!installFailed && failing.length === 0) return undefined;
  const lines: string[] = [];
  if (installFailed) {
    const { exitCode, logPath } = context.install!;
    const what = exitCode === null ? "did not finish (killed or timed out)" : `failed (exit ${exitCode})`;
    lines.push(`Warning: the repository's install ${what}; log: ${plain(logPath)}.`);
  }
  if (failing.length > 0) lines.push(`Failing before any change: ${failing.join(", ")}.`);
  lines.push(installFailed ? "A change implemented now cannot be verified against the project's own checks." : "Verification can only catch new failures, not these.");
  return lines.join(" ");
}

/**
 * Intel's notes, stable by contract, for a GitHub issue and pull request sample that was not read:
 * because the request failed (worth retrying), or because it was skipped on purpose.
 */
const SAMPLE_FAILED = "issue and PR samples unavailable: ";
const SAMPLE_SKIPPED = ["issue and PR sampling skipped: ", "issue, PR and CI sampling skipped by request"];

/**
 * Issues are where most opportunities come from. When intel says it did not read them, the list is
 * missing its main source, and the person choosing should know why. Only intel's notes decide this:
 * the profile's sample sizes measure response times, not whether issues were read.
 */
export function issueGap(report: AnalysisReport): string | undefined {
  const failed = report.budget.notes.find((n) => n.startsWith(SAMPLE_FAILED));
  const skipped = failed ? undefined : report.budget.notes.find((n) => SAMPLE_SKIPPED.some((prefix) => n.startsWith(prefix)));
  const note = failed ?? skipped;
  if (!note) return undefined;
  const prefix = failed ? SAMPLE_FAILED : SAMPLE_SKIPPED.find((p) => note.startsWith(p))!;
  const reason = note
    .slice(prefix.length)
    .replace(/^[;:,\s]+/, "")
    // Intel may append its own "were not analyzed, try again" clause; this sentence already says both.
    .replace(/;\s*issues and pull requests were not analyzed.*$/i, "")
    .trim();
  const why = reason ? ` (${plain(reason)})` : "";
  const advice = failed ? " Try again in a minute, or check your token with `gh auth status`." : "";
  return `Issues and pull requests were not analyzed${why}, so opportunities from them are missing.${advice}`;
}

/** The checks the engine runs, in its order (packages/engine/src/verify.ts). */
const CHECK_ORDER = ["typecheck", "lint", "build", "test"] as const;

/**
 * Which of the project's own commands the engine will run to check a change, from the same choice the
 * engine makes (packages/engine/src/intake.ts: the first command set that can run tests, else the
 * first). Said before anything runs, because verification is only as strong as these commands.
 */
/** The command set the engine runs: the first ecosystem with a test command, else the first one. */
function chosenCommands(profile: RepositoryProfile): Record<string, string | undefined> {
  const sets = profile.ecosystems.map((e) => e.commands as Record<string, string | undefined>);
  return sets.find((c) => c.test) ?? sets[0] ?? {};
}

export function checksLine(profile: RepositoryProfile): string {
  const chosen = chosenCommands(profile);
  const commands = CHECK_ORDER.map((name) => chosen[name]).filter((c): c is string => typeof c === "string" && c.length > 0).map(plain);
  if (commands.length === 0) return "No check commands were found, so the engine cannot verify the change against the project's own checks.";
  const noTests = chosen.test ? "" : " No test command was found; unless the agent finds one while investigating, the project's tests will not run.";
  return `The engine will check the change with the project's own commands: ${commands.join(", ")}.${noTests}`;
}

/**
 * Launchers the engine expects to find on this machine. It installs a project's dependencies, and
 * puts a Python project's virtualenv on PATH, but never installs these; a project whose commands
 * start with one that is missing fails at its install, minutes into a run.
 */
const TOOLCHAINS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "cargo", "go", "uv", "poetry", "pdm", "hatch", "make", "cmake", "mvn", "gradle", "bundle", "ruby", "rake", "composer", "php", "dotnet", "swift", "mix"]);

/** The program a command starts, after any leading VAR=value assignments. */
function programOf(command: string): string | undefined {
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

/** Toolchain launchers the engine's install and checks start, which `isAvailable` says this machine lacks. */
export function missingToolchains(profile: RepositoryProfile, isAvailable: (name: string) => boolean): string[] {
  const commands = Object.values(chosenCommands(profile)).filter((c): c is string => typeof c === "string");
  const programs = new Set(commands.map(programOf).filter((p): p is string => p !== undefined && TOOLCHAINS.has(p)));
  return [...programs].filter((p) => !isAvailable(p)).sort();
}

export function toolchainWarning(missing: string[]): string {
  const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  return `Warning: ${names} ${missing.length === 1 ? "is" : "are"} not installed on this machine (not on PATH). The project's install and checks need ${missing.length === 1 ? "it" : "them"}, so install ${missing.length === 1 ? "it" : "them"} first, or the run will stop after the install fails.`;
}

/** Whether an executable file `name` is in one of PATH's directories. */
export function onPath(name: string, path: string): boolean {
  return path.split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      const file = join(dir, name);
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
