import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createSdkRunner, type AgentRunner, type Effort, type PhaseResult, type PhaseSpec } from "./agent.ts";
import { preparePullRequest, publishPullRequest, type PublishResult } from "./deliver.ts";
import { forwardedCommand, PLAYWRIGHT_HOSTS, REGISTRY_HOSTS, startEgressProxy, proxyEnv, upstreamProxyFrom, type EgressProxy } from "./egress.ts";
import { execShell, tail } from "./exec.ts";
import { commandEnv, isInside, isSafeCommand, scrubEnv } from "./guard.ts";
import { hostSandboxFor, OFFLINE_ENV, specFor, type CheckIsolation, type HostIsolation } from "./hostbox.ts";
import { prepareToolchain } from "./toolchain.ts";
import { parseTask, sanitizeText, taskFromIntel } from "./intake.ts";
import { consoleReporter, RunJournal, type Reporter } from "./journal.ts";
import {
  afterDiff,
  afterOrient,
  atIntake,
  afterPlan,
  afterReview,
  afterVerify,
  blockerKeys,
  checkBudget,
  controlsChecks,
  DEFAULT_LIMITS,
  failureSignature,
  findSecrets,
  packageJsonControlChanged,
  type Decision,
  type Limits,
} from "./policy.ts";
import { builderSystemPrompt, fixReviewPrompt, fixVerificationPrompt, implementPrompt, orientPrompt, planPrompt, reviewerSystemPrompt, reviewPrompt, type RepositoryGuidance } from "./prompts.ts";
import { renderReport, type PhaseSummary } from "./report.ts";
import {
  ChangePlanSchema,
  ImplementationNotesSchema,
  InvestigationSchema,
  PreparedDeliverySchema,
  ReviewSchema,
  TaskSchema,
  type ChangePlan,
  type Check,
  type Commands,
  type ImplementationNotes,
  type Investigation,
  type PreparedDelivery,
  type Review,
  type RunResult,
  type Task,
  type TaskInput,
  type Verification,
} from "./types.ts";
import { checkSpecs, compareWithBaseline, runChecks } from "./verify.ts";
import { AS_TEXT, binaryChanges, DEFAULT_MAX_PATCH_BYTES, diffPatch, diffStats, git, GitError, prepareWorkspace, recordUntracked, removeWorkspace, showAtBase, unpublishedWork, untrackedFiles, type Workspace } from "./workspace.ts";

export interface RunInput {
  /** A Task written by hand or exported from an earlier run. */
  task?: TaskInput;
  /** Alternatively, intel's RepositoryProfile and ContributionOpportunity. */
  profile?: unknown;
  opportunity?: unknown;
}

/** What a person deciding on a plan should know about the environment it will be verified in. */
export interface PlanContext {
  /**
   * Present when the repository's install command ran and did not exit 0. `exitCode` is -1 when the
   * process was killed (timeout or signal); `timedOut` says which.
   */
  install?: { exitCode: number; logPath: string; timedOut: boolean };
  /** The repository's own checks before any change. */
  baseline: Check[];
}

export interface RunnerContext {
  workspace: string;
  task: Task;
  /** Environment for the agent process, including the run's toolchain (virtualenv on PATH and so on). */
  env?: Record<string, string>;
  /** Directories outside the workspace the agent's shell may write, such as the run's toolchain prefix. */
  extraWrite?: string[];
  /** The run's own temp directory, which the agent's shell gets instead of the shared ones. */
  tmp?: string;
}

export interface RunOptions {
  /** Directory that holds `runs/<id>/`. Defaults to `.gitgoblin` in the current directory. */
  workdir?: string;
  limits?: Partial<Limits>;
  reporter?: Reporter;
  /** Environment for agent sessions. Defaults to a scrubbed copy of process.env; repository commands get it minus model credentials. */
  env?: Record<string, string>;
  model?: string;
  effort?: Effort;
  isolation?: "sandbox" | "none";
  /**
   * OS sandbox for the repository's own commands (install, tests, lint, build), which run on this
   * machine: "auto" (default) uses sandbox-exec on macOS or bwrap on Linux when present and runs
   * bare otherwise with a warning; "sandbox" fails the run when none is available; "none" runs bare.
   */
  checkIsolation?: CheckIsolation;
  /** Timeout for each repository command (install, test, lint...). */
  checkTimeoutMs?: number;
  skipInstall?: boolean;
  /**
   * Optional human checkpoint between planning and implementation. The engine always passes the
   * context (how install and baseline went); it is optional in the type so one-argument callbacks
   * and callers written before it existed keep compiling.
   */
  approvePlan?: (plan: ChangePlan, context?: PlanContext) => Promise<boolean>;
  /** Largest patch the engine will review and commit; bigger ones escalate. Default 32 MiB. */
  maxPatchBytes?: number;
  /** Shallow clone depth for very large repositories; omitted means full history. */
  cloneDepth?: number;
  /**
   * What the repository's install may reach when an OS sandbox is in use: "registries" (default)
   * sends it through the engine's allowlisting proxy, "open" lets it reach any host. Without an OS
   * sandbox the install's network cannot be limited.
   */
  installNetwork?: "registries" | "open";
  /**
   * After the install, download the browsers a Playwright-based test suite needs
   * (`npx --no-install playwright install`, using the project's own Playwright), allowing
   * Playwright's download hosts for that step only. Browsers land in the shared cache, so this costs
   * time once per Playwright version. Off by default; the run says when the tests need it.
   */
  installBrowsers?: boolean;
  /**
   * Hosts the install may reach, besides the public package registries
   * (REGISTRY_HOSTS), for example a private registry. Entries starting with "." match subdomains.
   */
  installHosts?: string[];
  /** Replaces the Claude Agent SDK runner; tests use a scripted one. */
  runnerFactory?: (ctx: RunnerContext) => AgentRunner;
}

const PHASE_TURNS = { orient: 80, plan: 12, implement: 150, review: 40 } as const;

const GUIDANCE_CANDIDATES = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const TEMPLATE_CANDIDATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md"];
const MAX_GUIDANCE_FILE_CHARS = 20_000;
const MAX_GUIDANCE_FILE_BYTES = 4 * MAX_GUIDANCE_FILE_CHARS;

/**
 * Reads the start of a regular file inside the workspace. A repository can contain a symlink named
 * CONTRIBUTING.md that points at the operator's private key, or a path from the profile can climb
 * out of the checkout; both come back undefined. Reading a bounded prefix keeps a huge or
 * special file from stalling the run, and control characters that could hide instructions are
 * stripped before the text is quoted to the model.
 */
function readGuidanceFile(wsPath: string, rel: string): string | undefined {
  if (!isInside(rel, wsPath, wsPath)) return undefined;
  const file = path.resolve(wsPath, rel);
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return undefined;
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_GUIDANCE_FILE_BYTES + 1));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = sanitizeText(buffer.subarray(0, read).toString("utf8"));
    const truncated = stat.size > MAX_GUIDANCE_FILE_BYTES || text.length > MAX_GUIDANCE_FILE_CHARS;
    return truncated ? `${text.slice(0, MAX_GUIDANCE_FILE_CHARS)}\n[truncated]` : text;
  } finally {
    closeSync(fd);
  }
}

export function readGuidance(wsPath: string, task: Task): RepositoryGuidance & { template?: string } {
  const wanted = [...new Set([task.rules.contributingPath ?? "", ...task.rules.instructionFiles, ...GUIDANCE_CANDIDATES].filter(Boolean))];
  const files: RepositoryGuidance["files"] = [];
  for (const rel of wanted) {
    const content = readGuidanceFile(wsPath, rel);
    if (content) files.push({ path: rel, content });
  }
  const template = [task.rules.prTemplatePath ?? "", ...TEMPLATE_CANDIDATES]
    .filter(Boolean)
    .map((rel) => readGuidanceFile(wsPath, rel))
    .find((content) => content !== undefined);
  return { files, ...(template ? { template } : {}) };
}

/**
 * Changed files that decide what the verification commands execute on this machine. package.json
 * counts only when its scripts or similar sections changed, so a version bump or dependency update
 * does not stop the run.
 */
export async function checkControlChanges(wsPath: string, baseSha: string, changedFiles: string[], env: Record<string, string>): Promise<string[]> {
  const flagged: string[] = [];
  for (const file of changedFiles.filter(controlsChecks)) {
    if (path.basename(file) === "package.json") {
      const base = await showAtBase(wsPath, baseSha, file, env);
      const head = readGuidanceFileRaw(path.join(wsPath, file));
      if (!packageJsonControlChanged(base, head)) continue;
    }
    flagged.push(file);
  }
  return flagged;
}

function readGuidanceFileRaw(file: string): string | undefined {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 4 * 1024 * 1024) return undefined;
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

class RunAborted extends Error {
  readonly status: RunResult["status"];
  readonly reason: string;
  readonly questions: string[];

  constructor(status: RunResult["status"], reason: string, questions: string[] = []) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.questions = questions;
  }
}

/** Model-discovered commands run on the host; keep only plain, known tool invocations. */
function adoptDiscoveredCommands(task: Task, discovered: Commands, reporter: Reporter): (keyof Commands)[] {
  const adopted: (keyof Commands)[] = [];
  for (const [key, value] of Object.entries(discovered) as [keyof Commands, string | undefined][]) {
    if (!value || task.commands[key]) continue;
    if (!isSafeCommand(value)) {
      reporter.warn(`ignoring ${key} command from orientation (not a plain tool invocation): ${value}`);
      continue;
    }
    task.commands[key] = value;
    adopted.push(key);
  }
  return adopted;
}

/** Runs one contribution end to end and leaves the result in the run directory, ready for a human. */
export async function runContribution(input: RunInput, options: RunOptions = {}): Promise<RunResult> {
  const task = input.task ? parseTask(input.task) : taskFromIntel(input.profile, input.opportunity);
  const workdir = options.workdir ?? path.resolve(".gitgoblin");
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const reporter = options.reporter ?? consoleReporter();
  const baseEnv = options.env ?? scrubEnv();
  let env = baseEnv;
  let hostEnv = commandEnv(env);
  const journal = RunJournal.create(workdir);
  const started = Date.now();
  const phases: PhaseSummary[] = [];
  let checkIsolation: string | undefined;
  let installRestored: string[] = [];
  const setupNotes: string[] = [];
  let lastNotes: ImplementationNotes | undefined;
  let costUsd = 0;
  let workspace: Workspace | undefined;
  let investigation: Investigation | undefined;
  let verification: Verification | undefined;
  let review: Review | undefined;
  let delivery: PreparedDelivery | undefined;
  let agentTmp: string | undefined;

  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  journal.artifact("task", task);
  journal.event("run", "start", { runId: journal.runId, task: task.id, isolation: options.isolation ?? "sandbox" });
  reporter.phase("run", `${journal.runId} for ${task.title}`);
  if (options.isolation === "none") reporter.warn("isolation: none. The agent's commands run on this machine with only text-matching hooks between them and your files.");

  /** The patch between the base commit and the tree, or an escalation when it is too big to review. */
  const patch = async (ws: Workspace): Promise<string> => {
    try {
      return await diffPatch(ws.path, ws.baseSha, env, maxPatchBytes);
    } catch (err) {
      if (err instanceof GitError && err.exceeded) {
        throw new RunAborted("escalated", `the diff is too large to review (more than ${Math.round(maxPatchBytes / 1024)} KiB)`, ["Did the agent run a formatter or generator over the tree? Inspect the workspace before trusting any of it."]);
      }
      throw err;
    }
  };

  const decide = (phase: string, decision: Decision): void => {
    journal.event(phase, "decision", { ...decision });
    if (decision.action === "stop") throw new RunAborted("stopped", decision.reason);
    if (decision.action === "escalate") throw new RunAborted("escalated", decision.reason, decision.questions);
  };

  const phase = async <T>(runner: AgentRunner, spec: PhaseSpec<T>): Promise<PhaseResult<T> & { output: T }> => {
    decide(spec.name, checkBudget(costUsd, Date.now() - started, limits));
    reporter.phase(spec.name);
    journal.event(spec.name, "start", { resume: spec.resume ?? null });
    // The remaining wall-clock budget bounds the phase itself, not just the gate after it, so a
    // stalled session cannot hold the run past its limit.
    const remainingMs = Math.max(30_000, limits.maxWallClockMs - (Date.now() - started));
    const result = await runner.run({ ...spec, maxBudgetUsd: Math.max(0.5, limits.maxCostUsd - costUsd), timeoutMs: remainingMs });
    costUsd += result.costUsd;
    phases.push({ name: spec.name, costUsd: result.costUsd, turns: result.turns, durationMs: result.durationMs, ok: result.ok, denials: result.denials.length });
    journal.event(spec.name, "end", { ok: result.ok, costUsd: result.costUsd, turns: result.turns, errors: result.errors, denials: result.denials });
    for (const d of result.denials) reporter.warn(`${spec.name}: denied ${d.tool}: ${d.reason}`);
    if (!result.ok) {
      journal.text(`${spec.name}-output.txt`, result.text);
      throw new RunAborted("failed", `${spec.name} did not produce a result: ${result.errors.join("; ") || "no structured output"}`);
    }
    decide(spec.name, checkBudget(costUsd, Date.now() - started, limits));
    return result as PhaseResult<T> & { output: T };
  };

  try {
    decide("intake", atIntake(task));

    // Workspace, dependencies, guidance, baseline. Install and checks run on the host (setup phase),
    // with a credential-free environment; the agent's own commands run in the sandbox.
    reporter.phase("workspace", task.repo.localPath ? `worktree from ${task.repo.localPath}` : `clone ${task.repo.cloneUrl}`);
    workspace = await prepareWorkspace(task, journal.dir, env, options.cloneDepth ? { cloneDepth: options.cloneDepth } : {});
    journal.artifact("workspace", workspace);
    if (workspace.startNote) reporter.warn(workspace.startNote);
    if (options.isolation === "none" && workspace.source === "worktree") {
      reporter.warn("running without a sandbox on a worktree: the agent could reach the original checkout's git directory");
    }
    const hostBox: HostIsolation = hostSandboxFor(options.checkIsolation ?? "auto");
    const strict = options.checkIsolation === "strict";
    checkIsolation = strict ? `${hostBox.kind} (strict)` : hostBox.kind;
    journal.event("run", "check-isolation", { kind: hostBox.kind, strict });
    if (hostBox.kind === "none") {
      reporter.warn("repository commands run on this machine without an OS sandbox (none available or disabled); use a container for repositories you do not trust");
    } else {
      reporter.info(
        `repository commands run under ${hostBox.kind}${strict ? " (strict)" : ""}: writes limited to the workspace and tool caches, ${strict ? "home directory hidden except toolchains and caches, " : ""}credential paths hidden, ${(options.installNetwork ?? "registries") === "registries" ? "install limited to package registries" : "install network open"}, checks offline`,
      );
    }
    // A per-run prefix for what the toolchain installs, so `pip install -e .` lands in a virtualenv
    // under the run directory rather than in the operator's interpreter (which the sandbox refuses).
    const toolchain = await prepareToolchain(task, workspace.path, journal.dir, hostEnv);
    env = { ...baseEnv, ...toolchain.env };
    // The repository's commands get a temp directory of their own, removed with the workspace: the
    // shared ones hold other programs' control sockets and FIFOs (see SpecOptions.tmp).
    const commandTmp = journal.pathFor("tmp");
    mkdirSync(commandTmp, { recursive: true });
    hostEnv = { ...commandEnv(env), TMPDIR: commandTmp, TMP: commandTmp, TEMP: commandTmp };
    journal.event("run", "toolchain", { notes: toolchain.notes, writeDirs: toolchain.writeDirs });
    for (const note of toolchain.notes) reporter.info(note);
    const wrapFor = (network: boolean, extra: string[] = []) =>
      hostBox.kind === "none" ? {} : { wrap: (command: string) => hostBox.wrap(command, specFor(workspace!.path, network, { extraWrite: [...toolchain.writeDirs, ...extra], strict, tmp: commandTmp })) };
    const timeout = options.checkTimeoutMs ? { timeoutMs: options.checkTimeoutMs } : {};
    // Checks run with the network cut when sandboxed; say so to the package managers so they fail fast.
    // Python's bytecode cache would otherwise land beside every module the change adds.
    const checkEnv = { ...(hostBox.kind === "none" ? hostEnv : { ...hostEnv, ...OFFLINE_ENV }), PYTHONDONTWRITEBYTECODE: "1" };
    const checkOptions = { cwd: workspace.path, env: checkEnv, ...timeout, ...wrapFor(false) };
    // Each check's whole output goes to a file in the run directory; the artifacts keep an excerpt.
    const logChecks = (stage: string) => ({ ...checkOptions, onOutput: (check: Check, output: string) => journal.text(`check-${stage}-${check.name}.txt`, output) });
    let installFailure: PlanContext["install"];
    if (task.commands.install && !options.skipInstall) {
      reporter.phase("install", task.commands.install);
      // Strict isolation: the install reaches package registries only, through a proxy the engine
      // runs, with the sandbox allowing nothing but localhost. bubblewrap gives the install its own
      // network namespace, which cannot reach a proxy on the host's loopback, so there the install's
      // network stays open and the run says so.
      let egress: EgressProxy | undefined;
      const hosts = [...REGISTRY_HOSTS, ...(options.installHosts ?? []), ...(options.installBrowsers ? PLAYWRIGHT_HOSTS : [])];
      // sandbox-exec: the proxy on the host's 127.0.0.1, which the sandbox allows. bubblewrap: the
      // install has its own network namespace, so the proxy listens on a Unix socket in a folder bound
      // into the sandbox and a forwarder inside offers it on the namespace's 127.0.0.1.
      const egressDir = path.join(journal.dir, "egress");
      const socketPath = path.join(egressDir, "proxy.sock");
      let installCommand = task.commands.install;
      let installEnv: Record<string, string> = hostEnv;
      const limitInstall = (options.installNetwork ?? "registries") === "registries";
      const upstream = upstreamProxyFrom(hostEnv);
      const egressOptions = upstream ? { upstream } : {};
      if (limitInstall && hostBox.kind === "sandbox-exec") {
        egress = await startEgressProxy(hosts, egressOptions);
        installEnv = { ...hostEnv, ...proxyEnv(egress.url) };
      } else if (limitInstall && hostBox.kind === "bwrap") {
        mkdirSync(egressDir, { recursive: true });
        egress = await startEgressProxy(hosts, { ...egressOptions, socketPath });
        const forwarded = forwardedCommand(task.commands.install, socketPath);
        installCommand = forwarded.command;
        installEnv = { ...hostEnv, ...forwarded.env };
      }
      const installNetwork = egress ? "registries" : hostBox.kind === "none" ? "unsandboxed" : "open";
      journal.event("install", "start", { network: installNetwork });
      const installOptions = egress
        ? { cwd: workspace.path, env: installEnv, ...timeout, ...wrapFor(false, hostBox.kind === "bwrap" ? [egressDir] : []) }
        : { cwd: workspace.path, env: installEnv, ...timeout, ...wrapFor(true) };
      let install: Awaited<ReturnType<typeof execShell>>;
      let browsers: Awaited<ReturnType<typeof execShell>> | undefined;
      let denied: string[] = [];
      try {
        install = await execShell(installCommand, installOptions);
        // Playwright's browsers, when asked for and the project installed Playwright: the project's own
        // version (--no-install never fetches Playwright itself), through the same proxy.
        if (options.installBrowsers && install.exitCode === 0 && existsSync(path.join(workspace.path, "node_modules", "playwright-core", "package.json"))) {
          reporter.phase("install", "Playwright browsers");
          const browserCommand = "npx --no-install playwright install";
          if (egress && hostBox.kind === "bwrap") {
            const forwarded = forwardedCommand(browserCommand, socketPath);
            browsers = await execShell(forwarded.command, { ...installOptions, env: { ...hostEnv, ...forwarded.env } });
          } else {
            browsers = await execShell(browserCommand, installOptions);
          }
          journal.event("install", "browsers", { exitCode: browsers.exitCode, durationMs: browsers.durationMs, timedOut: browsers.timedOut });
          if (browsers.exitCode !== 0) reporter.warn(`installing Playwright's browsers failed (exit ${browsers.exitCode}); see install-output.txt`);
        }
      } finally {
        if (egress) {
          denied = egress.denied();
          await egress.close();
        }
      }
      if (egress) checkIsolation = `${hostBox.kind} (${strict ? "strict; " : ""}install limited to package registries${denied.length ? `, refused ${denied.length}: ${denied.slice(0, 5).join(", ")}` : ""})`;
      else if (hostBox.kind !== "none") checkIsolation = `${hostBox.kind} (${strict ? "strict; " : ""}install network open)`;
      const installLog = browsers ? `${install.output}\n[gitgoblin] npx --no-install playwright install\n${browsers.output}` : install.output;
      journal.text("install-output.txt", denied.length ? `${installLog}\n[gitgoblin] the install tried to reach hosts that are not package registries, refused: ${denied.join(", ")}\n` : installLog);
      // An install can rewrite tracked files (npm drops lockfile entries for workspaces missing from
      // the tree, formatters run in postinstall). That is not the contribution: put them back as
      // committed, so every diff from here on is measured against the repository's own files.
      const restored = await restoreTrackedChanges(workspace.path, env);
      if (restored.length) {
        installRestored = restored;
        reporter.warn(`install rewrote ${restored.join(", ")}; restored, the change is measured against the committed files`);
      }
      journal.event("install", "end", { exitCode: install.exitCode, durationMs: install.durationMs, timedOut: install.timedOut, network: installNetwork, refused: denied, restored, outputTail: tail(install.output, 2000) });
      if (denied.length) reporter.warn(`install tried to reach hosts that are not package registries (refused): ${denied.join(", ")}`);
      if (install.exitCode !== 0) {
        installFailure = { exitCode: install.exitCode ?? -1, logPath: journal.pathFor("install-output.txt"), timedOut: install.timedOut };
        reporter.warn(`install failed (exit ${install.exitCode}); checks may fail. Output: ${installFailure.logPath}`);
      }
    }
    const guidance = readGuidance(workspace.path, task);
    reporter.phase("baseline", checkSpecs(task.commands).map((s) => s.name).join(", ") || "no commands known");
    const baselineChecks = await runChecks(checkSpecs(task.commands), logChecks("baseline"));
    const baseline = compareWithBaseline(baselineChecks, undefined, { files: 0, insertions: 0, deletions: 0, changedFiles: [] });
    journal.artifact("baseline", baseline);
    // What the install and the checks wrote so far is theirs, not the agent's: keep it out of the change.
    await recordUntracked(workspace.path, env);
    // Untracked control files that git ignores, or that were there before the agent ran, never reach the
    // diff the gates read. These are the repository's and its checks'; one that appears or changes
    // once the agent has run is its doing.
    let untrackedControl = await untrackedFiles(workspace.path, env, controlsChecks);
    for (const c of baselineChecks.filter((c) => c.status !== "pass")) reporter.warn(`baseline ${c.name}: ${c.status}`);
    // A browser test suite whose browsers are missing fails before testing anything; say what fixes it.
    if (baselineChecks.some((c) => c.status !== "pass" && /ms-playwright/.test(c.outputTail) && /Executable doesn't exist|browserType\.launch|Please run the following command to download new browsers/.test(c.outputTail))) {
      const hint = options.installBrowsers
        ? "the tests need Playwright's browsers and installing them did not make them available; see install-output.txt"
        : "the tests need Playwright's browsers, which are not installed: run again with --install-browsers (downloads them from Playwright's servers into your cache), or run `npx playwright install` once yourself";
      setupNotes.push(hint);
      reporter.warn(hint);
    }
    // A failed install that leaves the checks broken means nothing the agent does could be verified;
    // stop here, before any model spend, with the log a person needs.
    if (installFailure && baselineChecks.length > 0 && baselineChecks.every((c) => c.status !== "pass")) {
      throw new RunAborted(
        "escalated",
        `install ${installFailure.timedOut ? "timed out" : `failed (exit ${installFailure.exitCode})`} and the repository's checks cannot run (${baselineChecks.map((c) => `${c.name}: ${c.status}`).join(", ")}); nothing the agent did could be verified`,
        [`Read ${installFailure.logPath}; fix the environment (missing tool, blocked write, network) and run again.`],
      );
    }

    // The SDK gives the agent's shell a temp directory under CLAUDE_CODE_TMPDIR, by default /tmp/claude-<uid>,
    // which every Claude Code session of this user shares. This one is the run's alone, and short, because
    // the SDK falls back to the shared one when the path is too long for the sockets it puts there.
    agentTmp = (options.isolation ?? "sandbox") === "sandbox" && process.platform !== "win32" ? mkdtempSync("/tmp/gg-") : undefined;
    const agentEnv = agentTmp ? { ...env, CLAUDE_CODE_TMPDIR: agentTmp } : env;
    const runner = (options.runnerFactory ?? defaultRunnerFactory(options, reporter))({ workspace: workspace.path, task, env: agentEnv, extraWrite: toolchain.writeDirs, tmp: commandTmp });
    const builderPrompt = builderSystemPrompt(task, workspace.path, guidance);
    const common = { systemPrompt: builderPrompt, profile: "build" as const, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) };
    // The checks run on this machine. If the agent rewired what they execute, in the diff or in a file git
    // ignores, a person reads that first; the engine does not run it.
    const refuseControlChanges = async (changedFiles: string[], patchName: string): Promise<void> => {
      const ws = workspace!;
      const hidden = [...(await untrackedFiles(ws.path, env, controlsChecks))].filter(([file, hash]) => untrackedControl.get(file) !== hash && !changedFiles.includes(file)).map(([file]) => `${file} (not in the diff)`);
      const control = [...(await checkControlChanges(ws.path, ws.baseSha, changedFiles, env)), ...hidden];
      if (control.length === 0) return;
      journal.text(patchName, await patch(ws));
      throw new RunAborted(
        "escalated",
        `the change edits files that decide what the verification commands run on this machine (${control.join(", ")}); the engine did not run them`,
        ["Read the diff of those files. If the change is intended, run the repository's checks yourself before trusting it."],
      );
    };

    // Orient.
    const orient = await phase(runner, { ...common, name: "orient", prompt: orientPrompt(task, baseline), schema: InvestigationSchema, maxTurns: PHASE_TURNS.orient, maxBudgetUsd: 0 });
    investigation = orient.output;
    journal.artifact("investigation", investigation);
    decide("orient", afterOrient(investigation));
    const adopted = adoptDiscoveredCommands(task, investigation.commands, reporter);
    if (adopted.length > 0) {
      journal.artifact("task", task);
      // Lint, build and typecheck discovered now still need a baseline; the test command does not get
      // one because the reproduction test already in the tree is meant to fail.
      const late = checkSpecs(Object.fromEntries(adopted.filter((k) => k !== "test").map((k) => [k, task.commands[k]])));
      if (late.length > 0) {
        // Orient may have written files (a reproduction test, or worse); these checks would run them.
        await refuseControlChanges((await diffStats(workspace.path, workspace.baseSha, env)).changedFiles, "diff-orient.patch");
        reporter.phase("baseline", `late: ${late.map((s) => s.name).join(", ")}`);
        baseline.checks.push(...(await runChecks(late, logChecks("baseline"))));
        journal.artifact("baseline", baseline);
        untrackedControl = await untrackedFiles(workspace.path, env, controlsChecks);
      }
    }
    let session = orient.sessionId;

    // Plan.
    const planned = await phase(runner, { ...common, name: "plan", prompt: planPrompt(limits.maxFilesChanged), schema: ChangePlanSchema, maxTurns: PHASE_TURNS.plan, maxBudgetUsd: 0, ...(session ? { resume: session } : {}) });
    const plan = planned.output;
    journal.artifact("plan", plan);
    decide("plan", afterPlan(plan, task, limits));
    if (options.approvePlan && !(await options.approvePlan(plan, { ...(installFailure ? { install: installFailure } : {}), baseline: baseline.checks }))) {
      throw new RunAborted("stopped", "plan rejected by the operator");
    }
    session = planned.sessionId ?? session;

    // Implement, verify, review: a bounded loop.
    const repro = investigation.reproduction;
    const reproduction = repro.kind === "test" && repro.command && isSafeCommand(repro.command) ? [{ name: "reproduction", command: repro.command }] : [];
    if (repro.kind === "test" && repro.command && reproduction.length === 0) reporter.warn(`ignoring reproduction command (not a plain tool invocation): ${repro.command}`);
    let prompt = implementPrompt(plan);
    let attempt = 0;
    let reviewRound = 0;
    let previousSignature: string | undefined;
    let previousBlockers: string[] = [];
    let notes: ImplementationNotes | undefined;
    let reviewedPatch = "";

    for (;;) {
      attempt += 1;
      const implemented = await phase(runner, { ...common, name: `implement-${attempt}`, prompt, schema: ImplementationNotesSchema, maxTurns: PHASE_TURNS.implement, maxBudgetUsd: 0, ...(session ? { resume: session } : {}) });
      notes = implemented.output;
      lastNotes = notes;
      session = implemented.sessionId ?? session;
      journal.artifact(`implementation-${attempt}`, notes);

      const diff = await diffStats(workspace.path, workspace.baseSha, env);
      if (diff.files === 0) throw new RunAborted("stopped", "the implementation changed no files");
      decide("diff", afterDiff(diff, task, limits));
      await refuseControlChanges(diff.changedFiles, `diff-${attempt}.patch`);
      const binary = await binaryChanges(workspace.path, workspace.baseSha, env);
      if (binary.length > 0) {
        throw new RunAborted("escalated", `the change adds or edits binary files (${binary.slice(0, 5).join(", ")}), which cannot be reviewed as a diff`, [
          "Look at those files yourself. If they belong in the change, add them by hand after reviewing the rest.",
        ]);
      }
      decide("verify", checkBudget(costUsd, Date.now() - started, limits));
      reporter.phase("verify", `${diff.files} files changed, +${diff.insertions} -${diff.deletions}`);
      const checks = await runChecks(checkSpecs(task.commands, reproduction), logChecks(`verify-${attempt}`));
      // What the checks themselves wrote is not the agent's; the next attempt is compared with this.
      untrackedControl = await untrackedFiles(workspace.path, env, controlsChecks);
      verification = compareWithBaseline(checks, baseline.checks, diff);
      journal.artifact(`verification-${attempt}`, verification);
      for (const c of checks) reporter.info(`${c.name}: ${c.status}`);

      const afterVerifyDecision = afterVerify(verification, attempt, previousSignature, limits);
      previousSignature = failureSignature(verification);
      if (afterVerifyDecision.action === "retry") {
        reporter.warn(afterVerifyDecision.reason);
        journal.event("verify", "retry", { attempt, reason: afterVerifyDecision.reason });
        prompt = fixVerificationPrompt(verification);
        continue;
      }
      decide("verify", afterVerifyDecision);
      // Passing checks do not make a half-done change whole; the implementer's own word does not go unread.
      if (!notes.done) {
        throw new RunAborted("escalated", `the implementer reports the change is not finished (${notes.summary.slice(0, 300)})`, [
          "Read the implementation notes and the diff. Finish the remaining steps yourself, or run again with a smaller plan.",
        ]);
      }

      reviewedPatch = await patch(workspace);
      journal.text(`diff-${attempt}.patch`, reviewedPatch);
      const secrets = findSecrets(reviewedPatch);
      if (secrets.length > 0) throw new RunAborted("escalated", `the diff adds something that looks like a secret (${secrets.join(", ")})`, ["Inspect the diff before anything is pushed."]);

      reviewRound += 1;
      const reviewed = await phase(runner, {
        name: `review-${reviewRound}`,
        systemPrompt: reviewerSystemPrompt(task, workspace.path, guidance),
        prompt: reviewPrompt(task, plan, notes, verification, reviewedPatch),
        schema: ReviewSchema,
        profile: "review",
        maxTurns: PHASE_TURNS.review,
        maxBudgetUsd: 0,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      });
      review = reviewed.output;
      journal.artifact(`review-${reviewRound}`, review);
      reporter.info(`review: ${review.verdict}${review.findings.length ? ` (${review.findings.length} findings)` : ""}`);

      const afterReviewDecision = afterReview(review, reviewRound, attempt, previousBlockers, limits);
      previousBlockers = blockerKeys(review);
      if (afterReviewDecision.action === "retry") {
        reporter.warn(afterReviewDecision.reason);
        journal.event("review", "retry", { round: reviewRound, reason: afterReviewDecision.reason });
        prompt = fixReviewPrompt(review);
        continue;
      }
      decide("review", afterReviewDecision);
      break;
    }

    // The reviewer has no write tools and a write-free sandbox, but the commit must still be exactly what was reviewed.
    if ((await patch(workspace)) !== reviewedPatch) {
      throw new RunAborted("escalated", "the workspace changed after the review", ["Compare the workspace with the reviewed diff before trusting it."]);
    }

    // Deliver: commit locally and write the pull request text. Publishing is a separate, approved step.
    reporter.phase("prepare", "commit and pull request text");
    delivery = await preparePullRequest({ task, plan, notes: notes!, verification: verification!, review: review!, ...(investigation ? { investigation } : {}), ...(guidance.template ? { template: guidance.template } : {}) }, workspace.path, workspace.baseSha, env);
    journal.artifact("delivery", delivery);
    journal.text("pr.md", delivery.prBody);
    journal.text("pr-title.txt", `${delivery.prTitle}\n`);
    journal.text("diff.patch", await git(["show", ...AS_TEXT, "--format=%H%n%s%n", "HEAD"], workspace.path, env, 5 * 60_000, maxPatchBytes));
    return finish("awaiting_approval", "ready for human review", []);
  } catch (err) {
    if (err instanceof RunAborted) return finish(err.status, err.reason, err.questions);
    const message = err instanceof Error ? err.message : String(err);
    journal.event("run", "error", { message });
    return finish("failed", message, []);
  } finally {
    if (agentTmp) await rm(agentTmp, { recursive: true, force: true });
  }

  function finish(status: RunResult["status"], reason: string, questions: string[]): RunResult {
    const result: RunResult = {
      runId: journal.runId,
      runDir: journal.dir,
      status,
      reason,
      questions,
      workspace: workspace?.path,
      branch: workspace?.branch,
      costUsd,
      durationMs: Date.now() - started,
    };
    journal.artifact("result", result);
    journal.text(
      "report.md",
      renderReport({
        result,
        task,
        phases,
        ...(investigation ? { investigation } : {}),
        ...(verification ? { verification } : {}),
        ...(review ? { review } : {}),
        ...(delivery ? { prTitle: delivery.prTitle } : {}),
        ...(checkIsolation ? { checkIsolation } : {}),
        ...(installRestored.length ? { installRestored } : {}),
        ...(setupNotes.length ? { setupNotes } : {}),
        ...(lastNotes ? { notes: lastNotes } : {}),
      }),
    );
    journal.event("run", "end", { status, reason, costUsd });
    reporter.phase("done", `${status}: ${reason} ($${costUsd.toFixed(2)})`);
    return result;
  }
}

function defaultRunnerFactory(options: RunOptions, reporter: Reporter): (ctx: RunnerContext) => AgentRunner {
  return (ctx) =>
    createSdkRunner({
      workspace: ctx.workspace,
      task: ctx.task,
      ...(ctx.env ? { env: ctx.env } : {}),
      ...(ctx.extraWrite ? { extraWrite: ctx.extraWrite } : {}),
      ...(ctx.tmp ? { tmp: ctx.tmp } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.isolation ? { isolation: options.isolation } : {}),
      onToolUse: (phaseName, tool, summary) => reporter.info(`${phaseName} ${tool} ${summary}`),
    });
}

export interface PublishRunOptions {
  workdir?: string;
  /** Must be true. The caller is responsible for having asked a human. */
  approved: boolean;
  draft?: boolean;
  dryRun?: boolean;
  env?: Record<string, string>;
  log?: (line: string) => void;
}

/** Pushes a prepared run's branch and opens the pull request. Refuses without explicit approval. */
export async function publishRun(runId: string, options: PublishRunOptions): Promise<PublishResult> {
  if (options.approved !== true) throw new Error("publishRun requires approved: true from a human");
  const journal = RunJournal.open(options.workdir ?? path.resolve(".gitgoblin"), runId);
  const result = journal.readArtifact<RunResult>("result");
  const rawTask = journal.readArtifact<unknown>("task");
  const rawDelivery = journal.readArtifact<unknown>("delivery");
  const workspace = journal.readArtifact<Workspace>("workspace");
  if (!result || !rawTask || !rawDelivery || !workspace) throw new Error(`run ${runId} has no prepared delivery`);
  if (result.status !== "awaiting_approval") throw new Error(`run ${runId} is ${result.status}, not awaiting approval`);
  // These files sat on disk since the run; parse them again rather than trust their shape.
  const task = TaskSchema.parse(rawTask);
  const delivery: PreparedDelivery = PreparedDeliverySchema.parse(rawDelivery);
  if (typeof workspace.path !== "string" || !existsSync(path.join(workspace.path, ".git"))) throw new Error(`run ${runId}: workspace ${String(workspace.path)} is not a git checkout`);
  const published = await publishPullRequest({
    task,
    delivery,
    wsPath: workspace.path,
    bodyFile: journal.pathFor("pr.md"),
    env: options.env ?? (process.env as Record<string, string>),
    ...(options.draft !== undefined ? { draft: options.draft } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  if (!options.dryRun) {
    journal.artifact("published", published);
    journal.artifact("result", { ...result, status: "published", reason: published.url });
    journal.event("publish", "end", { url: published.url });
  }
  return published;
}

export interface CleanRunOptions {
  workdir?: string;
  /** Also discard a prepared change that is still awaiting approval, or work done in a published run's workspace since. */
  force?: boolean;
  env?: Record<string, string>;
}

/**
 * Frees what a finished run holds on disk and in the operator's repository: the workspace (a clone,
 * or a worktree of a local checkout with its `gitgoblin/...` branch) and the run's toolchain and
 * egress folders. The report, the prepared pull request text, the diff and every artifact stay, so
 * the run can still be read. A run awaiting approval is kept unless `force` is set, since cleaning
 * it discards the prepared commit. The workspace record is checked before anything is deleted: the
 * path must lie inside the run's own directory and the branch must be one the engine names.
 */
export async function cleanRun(runId: string, options: CleanRunOptions = {}): Promise<{ removed: string[] }> {
  const journal = RunJournal.open(options.workdir ?? path.resolve(".gitgoblin"), runId);
  const env = options.env ?? (process.env as Record<string, string>);
  const result = journal.readArtifact<RunResult>("result");
  if (result?.status === "awaiting_approval" && !options.force) {
    throw new Error(`run ${runId} is awaiting approval; publish it, or clean with force to discard the prepared change`);
  }
  const removed: string[] = [];
  const workspace = journal.readArtifact<Workspace>("workspace");
  if (workspace) {
    const runDir = realpathSync(journal.dir);
    const wsPath = path.resolve(String(workspace.path));
    // Resolve through the nearest existing folder, so a workspace already removed still compares
    // against the run directory's real path (/var vs /private/var on macOS).
    let existing = wsPath;
    while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    const real = path.join(realpathSync(existing), path.relative(existing, wsPath));
    if (!real.startsWith(runDir + path.sep)) throw new Error(`run ${runId}: the workspace record points outside the run (${wsPath}); nothing was removed`);
    if (typeof workspace.branch !== "string" || !workspace.branch.startsWith("gitgoblin/")) {
      throw new Error(`run ${runId}: ${JSON.stringify(workspace.branch)} is not a gitgoblin branch; nothing was removed`);
    }
    const existed = existsSync(wsPath);
    // After publishing, the workspace is where a person answers review comments.
    if (existed && result?.status === "published" && !options.force) {
      const left = await unpublishedWork(wsPath, journal.readArtifact<{ commitSha?: unknown }>("delivery")?.commitSha, workspace.branch, env);
      if (left) throw new Error(`run ${runId} was published, and its workspace has ${left}. Push or copy what you want to keep; once it is safe (pushed already, say), clean with force`);
    }
    await removeWorkspace({ ...workspace, path: wsPath }, env);
    if (existed) removed.push(wsPath);
  }
  // Setup can fail after cloning (an empty repository, a failed checkout), before the workspace is recorded.
  for (const dir of [...(workspace ? [] : ["workspace"]), "toolchain", "egress", "tmp"]) {
    const full = journal.pathFor(dir);
    if (existsSync(full)) {
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    }
  }
  journal.event("run", "cleaned", { removed });
  return { removed };
}

/** Tracked files that differ from HEAD in the working tree, put back as committed. Returns their paths. */
async function restoreTrackedChanges(wsPath: string, env: Record<string, string>): Promise<string[]> {
  const status = await git(["status", "--porcelain", "--untracked-files=no", "-z"], wsPath, env).catch(() => "");
  const paths = status
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
  if (paths.length === 0) return [];
  await git(["checkout", "HEAD", "--", ...paths], wsPath, env);
  return paths;
}
