import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { DiscoveryQuery, DiscoveryResult, Goal, RepoRef } from "@gitgoblin/core";
import { GOAL_DESCRIPTIONS, GOALS, parseRepoRef, sameRepo } from "@gitgoblin/core";
import type { Effort, Reporter, RunResult } from "@gitgoblin/engine";
import type { AnalysisOptions, AnalysisReport, RepoRefInput } from "@gitgoblin/intel";
import { GOAL_PROFILES, type ProgressEvent, createDiscovery } from "@gitgoblin/discovery";
import { type HttpCache, MissingTokenError, RateLimitError, SqliteCache, defaultCachePath } from "@gitgoblin/sources";
import { Command, InvalidArgumentError } from "commander";
import { engineWillRefuse, formatOpportunities, formatPlan, recommendedRank, selectOpportunity } from "./contribute.ts";
import { formatExplanation, formatResults } from "./format.ts";
import { type DiscoverOptions, parseGoal, toQuery } from "./options.ts";
import { formatRuns, listRuns, readRun } from "./runs.ts";
import { type IntelModule, type ModuleLoader, isNotInstalled, loadEngine, loadIntel } from "./siblings.ts";

/** What the CLI needs from the engine; tests inject a fake. */
export interface Engine {
  discover(query: DiscoveryQuery): Promise<DiscoveryResult[]>;
  explain(ref: RepoRef, goal: Goal): Promise<DiscoveryResult | undefined>;
}

export interface Runtime {
  createEngine(options: { onProgress: (event: ProgressEvent) => void }): Promise<{ engine: Engine; close(): void; rateLimits(): string }>;
  openCache(): HttpCache;
  cachePath(): string;
  /** Imports a sibling package that may not be installed; undefined when it is not. */
  loadModule: ModuleLoader;
  /** Asks the person at the terminal a question and returns their answer. */
  ask(question: string): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
  /** stderr is a terminal, so progress lines are welcome. */
  isInteractive: boolean;
  /** stdin and stderr are terminals, so we can ask questions. */
  canPrompt: boolean;
  env: NodeJS.ProcessEnv;
}

const defaultRuntime: Runtime = {
  async createEngine({ onProgress }) {
    const { engine, sources } = await createDiscovery({ onProgress });
    return {
      engine,
      close: () => sources.close(),
      rateLimits: () =>
        Object.entries(sources.github.rateLimits())
          .map(([resource, state]) => `${resource} ${state.remaining}/${state.limit}`)
          .join(", "),
    };
  },
  openCache: () => new SqliteCache(defaultCachePath()),
  cachePath: defaultCachePath,
  async loadModule(name) {
    try {
      return (await import(name)) as Record<string, unknown>;
    } catch (error) {
      if (isNotInstalled(error, name)) return undefined;
      const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      throw new Error(`${name} is installed but failed to load: ${detail}`);
    }
  },
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  isInteractive: Boolean(process.stderr.isTTY),
  canPrompt: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  env: process.env,
};

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

async function confirm(runtime: Runtime, question: string): Promise<boolean> {
  const answer = (await runtime.ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Discovery's view of a repository, passed to intel as hints it validates rather than trusts. */
async function discoveryHints(runtime: Runtime, ref: RepoRef, goal: Goal): Promise<AnalysisOptions["hints"]> {
  const session = await runtime.createEngine({ onProgress: () => {} });
  try {
    const result = await session.engine.explain(ref, goal);
    return result ? { goal: result.goal, score: result.score, reasons: result.reasons, signals: result.signals, issues: result.issues } : undefined;
  } finally {
    session.close();
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function goalArgument(value: string): Goal {
  try {
    return parseGoal(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function repoArgument(value: string): RepoRef {
  const ref = parseRepoRef(value);
  if (!ref) throw new InvalidArgumentError(`Expected owner/name or a repository URL, got "${value}"`);
  return ref;
}

function effortArgument(value: string): Effort {
  if ((EFFORTS as readonly string[]).includes(value)) return value as Effort;
  throw new InvalidArgumentError(`Expected one of ${EFFORTS.join(", ")}, got "${value}"`);
}

function explainFailure(error: unknown, runtime: Runtime): string {
  if (error instanceof RateLimitError) {
    const hint = runtime.env.GITHUB_TOKEN || runtime.env.GH_TOKEN ? "Try again after the reset." : "Set GITHUB_TOKEN or run `gh auth login` for a much higher limit.";
    return `${error.message}. ${hint}`;
  }
  if (error instanceof MissingTokenError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function slug(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

/** Where the engine keeps runs and clones. One default for every command, so a run started by `contribute` is found by `publish`. */
function resolveWorkdir(runtime: Runtime, option: string | undefined): string {
  return resolve(option ?? runtime.env.GITGOBLIN_WORKDIR ?? join(homedir(), ".gitgoblin"));
}

/** The engine reports progress through this; the same shape its own CLI prints. */
function reporterFor(runtime: Runtime): Reporter {
  return {
    phase: (name, detail) => runtime.stderr(`==> ${detail ? `${name}: ${detail}` : name}`),
    info: (message) => runtime.stderr(`    ${message}`),
    warn: (message) => runtime.stderr(` !! ${message}`),
  };
}

/** One line for a failed parse. A zod error lists its issues as JSON; name the first field instead. */
function describeParseError(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0] as { path?: unknown[]; message?: string };
    const path = Array.isArray(first.path) && first.path.length > 0 ? first.path.join(".") : "report";
    return `${path}: ${first.message ?? "invalid"}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`;
  }
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "invalid";
}

/** A report saved by `analyze --json --out`, checked against intel's schema and against the repository asked for. */
function readSavedReport(intel: IntelModule, file: string, ref: RepoRef): AnalysisReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not an analysis report: ${describeParseError(error)}`);
  }
  let report: AnalysisReport;
  try {
    report = intel.AnalysisReport.parse(parsed);
  } catch (error) {
    throw new Error(`${file} is not an analysis report (expected the JSON written by \`gitgoblin analyze --json --out\`): ${describeParseError(error)}`);
  }
  const repo = report.profile.repo;
  if (!sameRepo({ host: repo.host, owner: repo.owner, name: repo.name }, ref)) throw new Error(`report ${file} is for ${repo.owner}/${repo.name}, not ${slug(ref)}`);
  return report;
}

/** What to type next, printed on stderr so piped output stays clean. */
function nextStepAfterAnalyze(report: AnalysisReport, ref: RepoRef, savedTo: string | undefined): string | undefined {
  if (report.opportunities.length === 0) return undefined;
  if (savedTo) return `Next: gitgoblin contribute ${slug(ref)} --report ${savedTo}`;
  const best = report.opportunities[recommendedRank(report) - 1];
  if (!best) return undefined;
  return [
    `Next: gitgoblin contribute ${slug(ref)} --opportunity ${best.id}`,
    `      (or save this report with --json --out report.json and pass --report report.json to skip re-analysis)`,
  ].join("\n");
}

export function buildProgram(runtime: Runtime): Command {
  const program = new Command("gitgoblin")
    .description("Find open-source projects worth your time, work out what they need, and prepare a pull request you approve.")
    .version("0.1.0")
    .configureOutput({ writeOut: (s) => runtime.stdout(s.trimEnd()), writeErr: (s) => runtime.stderr(s.trimEnd()) })
    .exitOverride();

  program
    .command("discover")
    .description("Rank repositories for a goal and say why")
    .argument("[goal]", `one of ${GOALS.join(", ")} (default: explore)`, goalArgument)
    .option("-l, --language <name>", "programming language (repeatable)", collect)
    .option("-t, --topic <name>", "GitHub topic (repeatable)", collect)
    .option("-k, --keyword <text>", "words to search for (repeatable)", collect)
    .option("--min-stars <n>", "minimum stars")
    .option("--max-stars <n>", "maximum stars")
    .option("--pushed-within <days>", "only repositories pushed in the last N days")
    .option("--created-within <days>", "only repositories created in the last N days")
    .option("--license <spdx>", "require this license, e.g. mit or apache-2.0")
    .option("--include-archived", "keep archived repositories")
    .option("--include-forks", "keep forks")
    .option("--exclude-owner <owner>", "skip this owner (repeatable)", collect)
    .option("--like <repo>", "find repositories similar to owner/name")
    .option("-n, --limit <n>", "how many results", "10")
    .option("--seed <n>", "random seed, makes the explore goal reproducible")
    .option("--json", "print JSON instead of text")
    .option("-v, --verbose", "show progress and rate limits on stderr")
    .action(async (goal: Goal | undefined, options: DiscoverOptions & { json?: boolean; verbose?: boolean }) => {
      const query = toQuery(goal ?? "explore", options);
      if (query.goal === "explore" && query.randomSeed === undefined) query.randomSeed = Math.floor(Math.random() * 1_000_000);
      const showProgress = Boolean(options.verbose) || (!options.json && runtime.isInteractive);
      const session = await runtime.createEngine({
        onProgress: (event) => {
          if (showProgress) runtime.stderr(`${event.stage}: ${event.message}`);
        },
      });
      try {
        const results = await session.engine.discover(query);
        if (options.json) runtime.stdout(JSON.stringify({ query, results }, null, 2));
        else {
          runtime.stdout(formatResults(results, { color: runtime.color }));
          if (query.goal === "explore") runtime.stderr(`seed ${query.randomSeed}: pass --seed ${query.randomSeed} to see these again`);
          const first = results[0];
          if (first && runtime.isInteractive) runtime.stderr(`Next: gitgoblin analyze ${first.repo.owner}/${first.repo.name}   (profile it and find concrete work to do)`);
        }
        if (options.verbose) runtime.stderr(`GitHub rate limits: ${session.rateLimits() || "unknown"}`);
      } finally {
        session.close();
      }
    });

  program
    .command("explain")
    .description("Show every signal, with evidence, for one repository")
    .argument("<repo>", "owner/name or URL", repoArgument)
    .option("-g, --goal <goal>", `one of ${GOALS.join(", ")}`, goalArgument, "contribute")
    .option("--json", "print JSON instead of text")
    .option("-v, --verbose", "show progress on stderr")
    .action(async (ref: RepoRef, options: { goal: Goal; json?: boolean; verbose?: boolean }) => {
      const session = await runtime.createEngine({
        onProgress: (event) => {
          if (options.verbose) runtime.stderr(`${event.stage}: ${event.message}`);
        },
      });
      try {
        const result = await session.engine.explain(ref, options.goal);
        if (!result) throw new Error(`${slug(ref)} was not found on ${ref.host}.`);
        runtime.stdout(options.json ? JSON.stringify(result, null, 2) : formatExplanation(result, { color: runtime.color }));
      } finally {
        session.close();
      }
    });

  program
    .command("goals")
    .description("List goals and the signals each one weighs")
    .option("--json", "print JSON instead of text")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        runtime.stdout(JSON.stringify(GOALS.map((goal) => ({ goal, description: GOAL_DESCRIPTIONS[goal], weights: GOAL_PROFILES[goal].weights })), null, 2));
        return;
      }
      for (const goal of GOALS) {
        const weights = Object.entries(GOAL_PROFILES[goal].weights)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .map(([name, weight]) => (weight < 0 ? `low ${name}` : name))
          .join(", ");
        runtime.stdout(`${goal.padEnd(11)} ${GOAL_DESCRIPTIONS[goal]}\n${"".padEnd(11)} weighs: ${weights}`);
      }
    });

  const cache = program.command("cache").description("Inspect or clear the local HTTP cache");
  cache
    .command("stats", { isDefault: true })
    .description("Show where the cache lives and how big it is")
    .action(() => {
      const store = runtime.openCache();
      try {
        const stats = store.stats();
        runtime.stdout(`${runtime.cachePath()}\n${stats.entries} entries, ${(stats.bytes / 1_048_576).toFixed(1)} MB`);
      } finally {
        store.close();
      }
    });
  cache
    .command("clear")
    .description("Delete every cached response")
    .action(() => {
      const store = runtime.openCache();
      try {
        store.clear();
        runtime.stdout("Cache cleared.");
      } finally {
        store.close();
      }
    });
  cache
    .command("prune")
    .description("Delete responses that expired more than a week ago")
    .action(() => {
      const store = runtime.openCache();
      try {
        runtime.stdout(`Removed ${store.prune(7 * 86_400_000)} expired entries.`);
      } finally {
        store.close();
      }
    });

  program
    .command("analyze")
    .description("Profile one repository and find evidence-backed work to do in it")
    .argument("<repo>", "owner/name or URL", repoArgument)
    .option("-g, --goal <goal>", `discovery goal used for hints, one of ${GOALS.join(", ")}`, goalArgument, "contribute")
    .option("--local <path>", "analyze an existing checkout at this path instead of cloning")
    .option("--max <n>", "maximum opportunities in the report", "15")
    .option("--no-links", "skip checking external links")
    .option("--no-deps", "skip dependency and vulnerability checks")
    .option("--out <file>", "write the report to a file instead of stdout")
    .option("--json", "print the AnalysisReport as JSON instead of Markdown (what `contribute --report` reads)")
    .option("-v, --verbose", "show analysis progress on stderr")
    .action(async (ref: RepoRef, options: { goal: Goal; local?: string; max: string; links: boolean; deps: boolean; out?: string; json?: boolean; verbose?: boolean }) => {
      const intel = await loadIntel(runtime.loadModule);
      if (!intel) throw new Error("The @gitgoblin/intel package is not available in this install, so analyze cannot run.");
      const maxOpportunities = Number(options.max);
      if (!Number.isInteger(maxOpportunities) || maxOpportunities < 1) throw new Error("--max must be a positive integer");
      const hints = await discoveryHints(runtime, ref, options.goal);
      const target: RepoRefInput = options.local ? { ...ref, localPath: resolve(options.local) } : ref;
      const report = await intel.analyzeRepository(target, {
        hints,
        maxOpportunities,
        checkLinks: options.links,
        dependencyChecks: options.deps,
        log: options.verbose ? (message: string) => runtime.stderr(message) : undefined,
      });
      const text = options.json ? JSON.stringify(report, null, 2) : intel.renderMarkdown(report);
      if (options.out) {
        await writeFile(options.out, `${text}\n`);
        runtime.stderr(`wrote ${options.out}`);
      } else {
        runtime.stdout(text);
      }
      const next = nextStepAfterAnalyze(report, ref, options.out && options.json ? options.out : undefined);
      if (next) runtime.stderr(next);
    });

  program
    .command("contribute")
    .description("Pick one opportunity, let the engine draft the change in a local clone, and open a draft pull request only after you approve")
    .argument("<repo>", "owner/name or URL", repoArgument)
    .option("--report <file>", "reuse a report saved by `analyze --json --out` instead of analyzing again")
    .option("--opportunity <id>", "work on this opportunity: its id from the report, or its rank in the list")
    .option("--issue <n>", "work on the opportunity for this issue number")
    .option("--max-cost <usd>", "spending cap for the agent run", "2")
    .option("--workdir <dir>", "where the engine keeps runs and clones (default: $GITGOBLIN_WORKDIR or ~/.gitgoblin)")
    .option("--model <id>", "model for the engine")
    .option("--effort <level>", `effort for the engine, one of ${EFFORTS.join(", ")}`, effortArgument)
    .option("-g, --goal <goal>", "discovery goal used for hints", goalArgument, "contribute")
    .action(async (ref: RepoRef, options: { report?: string; opportunity?: string; issue?: string; maxCost: string; workdir?: string; model?: string; effort?: Effort; goal: Goal }) => {
      if (!runtime.canPrompt) {
        throw new Error("contribute needs an interactive terminal: it asks before running an agent and again before publishing anything.");
      }
      const maxCostUsd = Number(options.maxCost);
      if (!(maxCostUsd > 0)) throw new Error("--max-cost must be a positive number of dollars");
      const [intel, engine] = await Promise.all([loadIntel(runtime.loadModule), loadEngine(runtime.loadModule)]);
      const missing = [intel ? undefined : "@gitgoblin/intel", engine ? undefined : "@gitgoblin/engine"].filter((name): name is string => name !== undefined);
      if (!intel || !engine) throw new Error(`contribute needs ${missing.join(" and ")}, not available in this install.`);
      const workdir = resolveWorkdir(runtime, options.workdir);
      if (options.issue !== undefined && options.opportunity !== undefined) throw new Error("Give either --issue or --opportunity, not both.");

      let report: AnalysisReport;
      if (options.report) {
        report = readSavedReport(intel, options.report, ref);
      } else {
        runtime.stderr(`Analyzing ${slug(ref)}...`);
        const hints = await discoveryHints(runtime, ref, options.goal);
        report = await intel.analyzeRepository(ref, { hints, log: runtime.isInteractive ? (message: string) => runtime.stderr(message) : undefined });
      }
      if (report.opportunities.length === 0) throw new Error(`No contribution opportunities found in ${slug(ref)}.`);

      let opportunity = selectOpportunity(report, { issue: options.issue, opportunity: options.opportunity });
      if (!opportunity) {
        runtime.stdout(formatOpportunities(report, { color: runtime.color }));
        const recommended = recommendedRank(report);
        for (let attempt = 1; !opportunity; attempt += 1) {
          const answer = (await runtime.ask(`Which opportunity? [1-${report.opportunities.length}, or an id; Enter for ${recommended}] `)).trim();
          try {
            opportunity = selectOpportunity(report, { opportunity: answer || String(recommended) });
          } catch (error) {
            if (attempt >= 3) throw error;
            runtime.stdout(error instanceof Error ? error.message : String(error));
          }
        }
      }
      runtime.stdout(`Opportunity: ${opportunity.title}`);
      const refusal = engineWillRefuse(opportunity);
      if (refusal) runtime.stdout(`The engine will refuse this one at intake: ${refusal}.`);

      // The engine clones the repository, unless the report came from `analyze --local`, in which case it
      // attaches a git worktree to that checkout. The person approves what will actually happen.
      const localPath = report.profile.repo.localPath;
      const where = localPath ? `a git worktree of ${localPath}` : "a local clone";
      const proceed = await confirm(
        runtime,
        `${refusal ? "Run it anyway" : "Run an AI agent"} against ${slug(ref)} in ${where}, spending up to $${maxCostUsd.toFixed(2)}? Nothing is published without another explicit yes.`,
      );
      if (!proceed) {
        runtime.stdout("Stopped before running the engine.");
        return;
      }

      const result = await engine.runContribution(
        { profile: report.profile, opportunity },
        {
          workdir,
          limits: { maxCostUsd },
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          approvePlan: async (plan) => confirm(runtime, `\n${formatPlan(plan)}\n\nImplement this plan?`),
          reporter: reporterFor(runtime),
        },
      );

      runtime.stdout("");
      for (const line of describeRun(result)) runtime.stdout(line);
      const reportText = readText(join(result.runDir, "report.md"));
      if (reportText) runtime.stdout(`\n${reportText}`);
      if (result.status === "failed") throw new Error(`the run failed: ${result.reason}`);
      if (result.status !== "awaiting_approval") {
        runtime.stdout("Nothing to publish.");
        return;
      }

      const title = readText(join(result.runDir, "pr-title.txt"));
      const body = readText(join(result.runDir, "pr.md"));
      runtime.stdout(`\nProposed pull request${title ? `: ${title}` : ""}\n`);
      if (body) runtime.stdout(body);
      runtime.stdout(`\nDiff: ${join(result.runDir, "diff.patch")}`);
      runtime.stdout(`Read the diff and the report before publishing. To decide later: gitgoblin publish ${result.runId}${options.workdir ? ` --workdir ${workdir}` : ""}`);

      const publish = await confirm(runtime, "Open a draft pull request on GitHub under your account?");
      if (!publish) {
        runtime.stdout(`Not published. The change stays in ${result.runDir}.`);
        return;
      }
      const published = await engine.publishRun(result.runId, { workdir, approved: true, draft: true, log: (line) => runtime.stderr(line) });
      runtime.stdout(`Draft pull request: ${published.url}`);
    });

  program
    .command("runs")
    .description("List the contribution runs under the workdir and what became of each")
    .option("--workdir <dir>", "where the engine keeps runs (default: $GITGOBLIN_WORKDIR or ~/.gitgoblin)")
    .action((options: { workdir?: string }) => {
      const workdir = resolveWorkdir(runtime, options.workdir);
      runtime.stdout(formatRuns(listRuns(workdir), { color: runtime.color }, options.workdir ? ` --workdir ${workdir}` : ""));
    });

  program
    .command("show")
    .description("Show what a run did: its report, or with --diff or --pr the change and the pull request text")
    .argument("<runId>", "a run id from `gitgoblin runs`")
    .option("--diff", "print the prepared change as a patch")
    .option("--pr", "print the pull request title and description")
    .option("--workdir <dir>", "where the engine keeps runs (default: $GITGOBLIN_WORKDIR or ~/.gitgoblin)")
    .action((runId: string, options: { diff?: boolean; pr?: boolean; workdir?: string }) => {
      const workdir = resolveWorkdir(runtime, options.workdir);
      const run = readRun(workdir, runId);
      if (!run) throw new Error(`no run "${runId}" under ${workdir}; \`gitgoblin runs\` lists them.`);
      if (options.diff) runtime.stdout(run.diff ?? `run ${runId} prepared no change (${run.result.status}: ${run.result.reason})`);
      else if (options.pr) runtime.stdout([run.prTitle, run.prBody].filter(Boolean).join("\n\n") || `run ${runId} prepared no pull request (${run.result.status}: ${run.result.reason})`);
      else runtime.stdout(run.report ?? JSON.stringify(run.result, null, 2));
    });

  program
    .command("publish")
    .description("Push a prepared run's change and open a pull request under your account, after you confirm")
    .argument("<runId>", "a run id from `gitgoblin runs`")
    .option("--ready", "open the pull request ready for review instead of as a draft")
    .option("--workdir <dir>", "where the engine keeps runs (default: $GITGOBLIN_WORKDIR or ~/.gitgoblin)")
    .action(async (runId: string, options: { ready?: boolean; workdir?: string }) => {
      if (!runtime.canPrompt) throw new Error("publish needs an interactive terminal: it asks before pushing anything.");
      const workdir = resolveWorkdir(runtime, options.workdir);
      const run = readRun(workdir, runId);
      if (!run) throw new Error(`no run "${runId}" under ${workdir}; \`gitgoblin runs\` lists them.`);
      if (run.result.status !== "awaiting_approval") throw new Error(`run ${runId} is ${run.result.status} (${run.result.reason}), so there is nothing to publish.`);
      const engine = await loadEngine(runtime.loadModule);
      if (!engine) throw new Error("publish needs @gitgoblin/engine, not available in this install.");

      runtime.stdout(`Pull request${run.prTitle ? `: ${run.prTitle}` : ""}\n`);
      if (run.prBody) runtime.stdout(run.prBody);
      runtime.stdout(`\nDiff: ${run.diffPath}\nReport: ${join(run.dir, "report.md")}`);
      const draft = !options.ready;
      const ok = await confirm(runtime, `Push this change and open a ${draft ? "draft" : "ready-for-review"} pull request on GitHub under your account?`);
      if (!ok) {
        runtime.stdout("Not published.");
        return;
      }
      const published = await engine.publishRun(runId, { workdir, approved: true, draft, log: (line) => runtime.stderr(line) });
      runtime.stdout(`${draft ? "Draft pull request" : "Pull request"}: ${published.url}`);
    });

  return program;
}

function describeRun(result: RunResult): string[] {
  const lines = [`Run ${result.status}: ${result.reason}`, `Cost: $${result.costUsd.toFixed(2)} in ${Math.round(result.durationMs / 1000)}s`, `Run directory: ${result.runDir}`];
  for (const question of result.questions) lines.push(`Question for you: ${question}`);
  return lines;
}

/** Runs the CLI and returns the exit code. */
export async function run(argv: string[], runtime: Runtime = defaultRuntime): Promise<number> {
  const program = buildProgram(runtime);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error && typeof error === "object" && "exitCode" in error && "code" in error) {
      // commander already printed help or a usage error
      const code = (error as { exitCode: number; code: string }).code;
      return code === "commander.helpDisplayed" || code === "commander.version" || code === "commander.help" ? 0 : 2;
    }
    runtime.stderr(`error: ${explainFailure(error, runtime)}`);
    return 1;
  }
}
