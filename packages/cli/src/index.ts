import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { DiscoveryQuery, DiscoveryResult, Goal, RepoRef } from "@gitgoblin/core";
import { GOAL_DESCRIPTIONS, GOALS, parseRepoRef } from "@gitgoblin/core";
import { type DiscoveryEngine, GOAL_PROFILES, type ProgressEvent, createDiscovery } from "@gitgoblin/discovery";
import { type HttpCache, MissingTokenError, RateLimitError, SqliteCache, defaultCachePath } from "@gitgoblin/sources";
import { Command, InvalidArgumentError } from "commander";
import { formatExplanation, formatResults } from "./format.ts";
import { type DiscoverOptions, parseGoal, toQuery } from "./options.ts";

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
  loadModule(name: string): Promise<Record<string, unknown> | undefined>;
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
    } catch {
      return undefined;
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

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict {
  return value && typeof value === "object" ? (value as Dict) : {};
}

async function confirm(runtime: Runtime, question: string): Promise<boolean> {
  const answer = (await runtime.ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Discovery's view of a repository, passed to intel and the engine as hints. */
async function discoveryHints(runtime: Runtime, ref: RepoRef, goal: Goal): Promise<Dict | undefined> {
  const session = await runtime.createEngine({ onProgress: () => {} });
  try {
    const result = await session.engine.explain(ref, goal);
    return result ? { goal: result.goal, score: result.score, reasons: result.reasons, signals: result.signals, issues: result.issues } : undefined;
  } finally {
    session.close();
  }
}

function opportunityLabel(opportunity: Dict): string {
  const issue = asDict(opportunity.issue);
  const number = opportunity.issueNumber ?? issue.number;
  const title = opportunity.title ?? opportunity.summary ?? issue.title ?? "(untitled)";
  return `${number !== undefined ? `#${String(number)} ` : ""}${String(title)}`;
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

function explainFailure(error: unknown, runtime: Runtime): string {
  if (error instanceof RateLimitError) {
    const hint = runtime.env.GITHUB_TOKEN || runtime.env.GH_TOKEN ? "Try again after the reset." : "Set GITHUB_TOKEN or run `gh auth login` for a much higher limit.";
    return `${error.message}. ${hint}`;
  }
  if (error instanceof MissingTokenError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function buildProgram(runtime: Runtime): Command {
  const program = new Command("gitgoblin")
    .description("Discover public software projects worth your time, for whatever you are trying to do.")
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
        if (!result) throw new Error(`${ref.owner}/${ref.name} was not found on ${ref.host}.`);
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
    .description("Deep-dive one repository with @gitgoblin/intel: profile, conventions and contribution opportunities")
    .argument("<repo>", "owner/name or URL", repoArgument)
    .option("-g, --goal <goal>", `discovery goal used for hints, one of ${GOALS.join(", ")}`, goalArgument, "contribute")
    .option("--max <n>", "maximum opportunities in the report", "15")
    .option("--no-links", "skip checking external links")
    .option("--no-deps", "skip dependency and vulnerability checks")
    .option("--out <file>", "write the report to a file instead of stdout")
    .option("--json", "print the AnalysisReport as JSON instead of Markdown")
    .option("-v, --verbose", "show analysis progress on stderr")
    .action(async (ref: RepoRef, options: { goal: Goal; max: string; links: boolean; deps: boolean; out?: string; json?: boolean; verbose?: boolean }) => {
      const intel = await runtime.loadModule("@gitgoblin/intel");
      if (typeof intel?.analyzeRepository !== "function") {
        throw new Error("The @gitgoblin/intel package is not available in this install, so analyze cannot run.");
      }
      const maxOpportunities = Number(options.max);
      if (!Number.isInteger(maxOpportunities) || maxOpportunities < 1) throw new Error("--max must be a positive integer");
      const hints = await discoveryHints(runtime, ref, options.goal);
      const analyze = intel.analyzeRepository as (r: RepoRef, o: Dict) => Promise<unknown>;
      const report = await analyze(ref, {
        hints,
        maxOpportunities,
        checkLinks: options.links,
        dependencyChecks: options.deps,
        log: options.verbose ? (message: string) => runtime.stderr(message) : undefined,
      });
      const render = typeof intel.renderMarkdown === "function" ? (intel.renderMarkdown as (r: unknown) => string) : undefined;
      const text = options.json || !render ? JSON.stringify(report, null, 2) : render(report);
      if (options.out) {
        await writeFile(options.out, `${text}\n`);
        runtime.stderr(`wrote ${options.out}`);
      } else {
        runtime.stdout(text);
      }
    });

  program
    .command("contribute")
    .description("Analyze a repository, let the engine draft a change, and open a draft pull request only after you approve")
    .argument("<repo>", "owner/name or URL", repoArgument)
    .option("--issue <n>", "work on the opportunity for this issue number")
    .option("--max-cost <usd>", "spending cap for the agent run", "2")
    .option("--workdir <dir>", "where the engine keeps runs and clones (default: $GITGOBLIN_WORKDIR or ~/.gitgoblin)")
    .option("--model <id>", "model for the engine")
    .option("--effort <level>", "effort for the engine")
    .option("-g, --goal <goal>", "discovery goal used for hints", goalArgument, "contribute")
    .action(async (ref: RepoRef, options: { issue?: string; maxCost: string; workdir?: string; model?: string; effort?: string; goal: Goal }) => {
      if (!runtime.canPrompt) {
        throw new Error("contribute needs an interactive terminal: it asks before running an agent and again before publishing anything.");
      }
      const maxCostUsd = Number(options.maxCost);
      if (!(maxCostUsd > 0)) throw new Error("--max-cost must be a positive number of dollars");
      const [intel, engine] = await Promise.all([runtime.loadModule("@gitgoblin/intel"), runtime.loadModule("@gitgoblin/engine")]);
      const missing = [
        typeof intel?.analyzeRepository === "function" ? undefined : "@gitgoblin/intel",
        typeof engine?.runContribution === "function" && typeof engine?.publishRun === "function" ? undefined : "@gitgoblin/engine",
      ].filter((name): name is string => name !== undefined);
      if (missing.length > 0) throw new Error(`contribute needs ${missing.join(" and ")}, not available in this install.`);
      const workdir = options.workdir ?? runtime.env.GITGOBLIN_WORKDIR ?? join(homedir(), ".gitgoblin");

      runtime.stderr(`Analyzing ${ref.owner}/${ref.name}...`);
      const hints = await discoveryHints(runtime, ref, options.goal);
      const report = asDict(await (intel!.analyzeRepository as (r: RepoRef, o: Dict) => Promise<unknown>)(ref, { hints }));
      const opportunities = (Array.isArray(report.opportunities) ? report.opportunities : []).map(asDict);
      if (opportunities.length === 0) throw new Error("No contribution opportunities found.");

      let opportunity: Dict | undefined;
      if (options.issue !== undefined) {
        opportunity = opportunities.find((o) => String(o.issueNumber ?? asDict(o.issue).number) === options.issue);
        if (!opportunity) throw new Error(`No opportunity for issue #${options.issue}. Available: ${opportunities.map(opportunityLabel).join("; ")}`);
      } else if (opportunities.length === 1) {
        opportunity = opportunities[0];
      } else {
        opportunities.forEach((o, i) => runtime.stdout(`${i + 1}. ${opportunityLabel(o)}`));
        const picked = Number((await runtime.ask(`Which opportunity? [1-${opportunities.length}] `)).trim() || "1");
        opportunity = opportunities[picked - 1];
      }
      if (!opportunity) throw new Error("No opportunity chosen.");
      runtime.stdout(`Opportunity: ${opportunityLabel(opportunity)}`);

      const proceed = await confirm(
        runtime,
        `Run an AI agent against ${ref.owner}/${ref.name} in a local clone, spending up to $${maxCostUsd.toFixed(2)}? Nothing is published without another explicit yes.`,
      );
      if (!proceed) {
        runtime.stdout("Stopped before running the engine.");
        return;
      }

      const run = engine!.runContribution as (input: Dict, options: Dict) => Promise<unknown>;
      const result = asDict(
        await run(
          { profile: report.profile, opportunity },
          {
            workdir,
            limits: { maxCostUsd },
            model: options.model,
            effort: options.effort,
            approvePlan: async (plan: unknown) =>
              confirm(runtime, `Proposed plan:\n${typeof plan === "string" ? plan : JSON.stringify(plan, null, 2)}\nProceed with this plan?`),
            reporter: (event: unknown) => runtime.stderr(typeof event === "string" ? event : JSON.stringify(event)),
          },
        ),
      );

      const runDir = String(result.runDir ?? "");
      runtime.stdout(`status: ${String(result.status)}${result.reason ? ` (${String(result.reason)})` : ""}`);
      if (runDir) runtime.stdout(`run: ${runDir}`);
      runtime.stdout(`cost: $${Number(result.costUsd ?? 0).toFixed(2)}`);
      for (const question of Array.isArray(result.questions) ? result.questions : []) runtime.stdout(`question: ${String(question)}`);
      const title = runDir ? readText(join(runDir, "pr-title.txt")) : undefined;
      const body = runDir ? readText(join(runDir, "pr.md")) : undefined;
      if (title || body) runtime.stdout(`\n${[title, body].filter(Boolean).join("\n\n")}`);

      if (result.status !== "awaiting_approval") {
        runtime.stdout("Nothing to publish.");
        return;
      }
      const publish = await confirm(runtime, "Open a draft pull request on GitHub under your account?");
      if (!publish) {
        runtime.stdout(`Not published. The change stays in ${runDir || "the run directory"}.`);
        return;
      }
      const publishRun = engine!.publishRun as (runId: unknown, options: Dict) => Promise<unknown>;
      const published = asDict(await publishRun(result.runId, { workdir, approved: true, draft: true }));
      runtime.stdout(`Draft pull request: ${String(published.url ?? "(no url returned)")}`);
    });

  return program;
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
