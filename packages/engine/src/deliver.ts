import { subjectFor, typeForKind } from "./naming.ts";
import { execFile } from "./exec.ts";
import type { ChangePlan, ImplementationNotes, Investigation, PreparedDelivery, Review, Task, Verification } from "./types.ts";
import { commitAll, git } from "./workspace.ts";

export interface DeliveryInput {
  task: Task;
  plan: ChangePlan;
  notes: ImplementationNotes;
  verification: Verification;
  review: Review;
  /** The orientation's findings; its root cause explains the change in the pull request summary. */
  investigation?: Investigation;
  /** Content of the repository's pull request template, if any. */
  template?: string;
}

const ISSUE_REF = String.raw`(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https?:\/\/[^\s)]+\/(?:issues|pull)\/\d+`;
const CLOSING = new RegExp(String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?\s+)((?:${ISSUE_REF})(?:(?:\s*,\s*|\s+and\s+|\s+)(?:${ISSUE_REF}))*)`, "gi");
const REF = new RegExp(ISSUE_REF, "g");
const MENTION = /(^|[^\w`/.@-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?)/g;

/**
 * Makes text that the model or a third party wrote inert on GitHub: an `@name` would notify someone
 * who never asked to be involved, and a closing keyword such as "Closes #12" in a pull request body
 * or commit message would close that issue when a maintainer merges. Both become inline code, which
 * GitHub shows as written but does not act on. Existing code spans are left as they are. The
 * engine's own "Fixes #N" line for the task's issue is added after this, so it still works.
 */
export function neutralizeForGitHub(text: string, ownIssue?: number): string {
  const own = ownIssue === undefined ? undefined : `#${ownIssue}`;
  return text
    .split(/(`+[^`]*`+)/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // an existing code span
      return part
        .replace(CLOSING, (_m, keyword: string, sep: string, refs: string) => `${keyword}${sep}${refs.replace(REF, (ref) => (ref === own ? ref : `\`${ref}\``))}`)
        .replace(MENTION, (_m, lead: string, name: string) => `${lead}\`@${name}\``);
    })
    .join("");
}

/**
 * Notes about the agent's own working conditions (the sandbox, the network, a package manager's lock)
 * mean nothing to a maintainer and expose the operator's setup. The prompt asks for them in
 * environmentNotes; this catches the ones that still land in the maintainer-facing lists.
 */
const ENVIRONMENT_NOTE = /\bsandbox|ERR_PNPM_|\bEPERM\b|operation not permitted|reach the network|no network access|network access|\.pnpm-store|store lock|install-output\.txt|\bphase \d\b|\buntracked\b|\bthe (?:review )?hook\b|\bmy operator\b|\brecommend (?:approving|approval)\b/i;

export function forMaintainers(lines: string[]): string[] {
  return lines.filter((line) => !ENVIRONMENT_NOTE.test(line));
}

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4));
}

/** True when `text` says much the same as one of `seen` (word overlap of at least half). */
function restates(text: string, seen: Set<string>[]): boolean {
  const mine = words(text);
  if (mine.size === 0) return false;
  return seen.some((other) => {
    let shared = 0;
    for (const w of mine) if (other.has(w)) shared += 1;
    return shared / (mine.size + other.size - shared) >= 0.5;
  });
}

export function commitMessage(input: DeliveryInput): string {
  const own = input.task.issue?.number;
  const subject = neutralizeForGitHub(subjectFor(input.task, input.plan.goal, input.plan.commitSubject), own);
  const body = [neutralizeForGitHub(input.notes.summary.trim(), own), input.task.issue ? `Refs #${input.task.issue.number}` : ""].filter(Boolean).join("\n\n");
  return `${subject}\n\n${body}\n`;
}

function checklistFrom(template: string | undefined): string[] {
  if (!template) return [];
  return template
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\[[ xX]\]/.test(l))
    .map((l) => l.replace(/^[-*]\s+\[[ xX]\]/, "- [ ]"));
}

export function pullRequestTitle(input: DeliveryInput): string {
  return neutralizeForGitHub(subjectFor(input.task, input.plan.goal, input.plan.commitSubject), input.task.issue?.number);
}

export function pullRequestBody(input: DeliveryInput): string {
  const { task, plan, notes, verification, review } = input;
  const n = (text: string) => neutralizeForGitHub(text, task.issue?.number);
  const closes = typeForKind(task.kind) === "fix" ? "Fixes" : "Refs";
  // The plan's goal says what this change does in one sentence. The task summary is often the issue
  // body (template questions and all), which the linked issue already shows.
  const rootCause = input.investigation?.rootCause?.trim();
  const goal = plan.goal.trim().replace(/([^.!?])$/, "$1.");
  const summaryLines = [
    n(rootCause && rootCause.length <= 400 && !ENVIRONMENT_NOTE.test(rootCause) ? `${goal} ${rootCause.replace(/([^.!?])$/, "$1.")}` : goal),
    task.issue ? `${closes} #${task.issue.number}` : "",
  ].filter(Boolean);
  const preexisting = new Set(verification.preexisting ?? []);
  const checks = verification.checks.map((c) => `| \`${c.command}\` | ${c.status}${preexisting.has(c.name) ? " (also fails on the base commit)" : ""} |`);
  // Deviations from the plan are the engine's bookkeeping, not something a maintainer needs; findings
  // about files outside the change (a stray directory in the workspace) are not about the change.
  const changed = new Set(verification.diff.changedFiles);
  // The reviewer often restates what the implementer already listed as a known gap; say it once.
  const gaps = forMaintainers(notes.knownGaps);
  const said = gaps.map(words);
  const nits = review.findings
    .filter((f) => (f.severity === "minor" || f.severity === "nit") && changed.has(f.file))
    .filter((f) => forMaintainers([f.summary]).length === 1 && !restates(f.summary, said));
  const prNotes = review.prNotes && forMaintainers([review.prNotes]).length === 1 && !restates(review.prNotes, [...said, ...nits.map((f) => words(f.summary))]) ? review.prNotes : "";
  const reviewerNotes = [
    ...gaps.map((g) => `- ${n(g)}`),
    ...nits.map((f) => `- Reviewer note (${f.severity}): ${n(f.summary)}`),
    prNotes ? `- ${n(prNotes)}` : "",
  ].filter(Boolean);
  const checklist = checklistFrom(input.template);

  return [
    "## Summary",
    summaryLines.join("\n\n"),
    "",
    "## Changes",
    n(notes.summary.trim()),
    "",
    "## Verification",
    "| Command | Result |",
    "|---|---|",
    ...checks,
    verification.regressions.length ? `\nRegressions versus the base commit: ${verification.regressions.join(", ")}` : "\nNo regressions versus the base commit.",
    ...(reviewerNotes.length ? ["", "## Notes for reviewers", ...reviewerNotes] : []),
    ...(checklist.length ? ["", "## Checklist", ...checklist] : []),
    "",
    "---",
    "Prepared with [gitgoblin](https://github.com/anandkaranubc/gitgoblin) ([how it works and what it promises](https://github.com/anandkaranubc/gitgoblin/blob/main/docs/etiquette.md)); a human reviewed this change and approved opening the pull request.",
    "",
  ].join("\n");
}

/** Commits the workspace and writes the pull request text. Nothing leaves the machine. */
export async function preparePullRequest(input: DeliveryInput, wsPath: string, baseSha: string, env: Record<string, string>): Promise<PreparedDelivery> {
  const message = commitMessage(input);
  const commitSha = await commitAll(wsPath, baseSha, message, env, Boolean(input.task.rules.dco));
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], wsPath, env);
  return { branch, commitSha, commitMessage: message, prTitle: pullRequestTitle(input), prBody: pullRequestBody(input) };
}

export interface PublishOptions {
  task: Task;
  delivery: PreparedDelivery;
  wsPath: string;
  bodyFile: string;
  env: Record<string, string>;
  draft?: boolean;
  /** Print the commands instead of running them. */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Replaces the gh calls and the push; tests use it to simulate GitHub. */
  runner?: { gh(args: string[]): Promise<string>; push(args: string[]): Promise<string> };
}

export interface PublishResult {
  url: string;
  head: string;
  pushedTo: string;
  commands: string[];
}

async function gh(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const result = await execFile("gh", args, { cwd, env, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.output.trim().split("\n").slice(-3).join(" | ")}`);
  return result.output.trim();
}

/** The operator's fork of `repo`: GitHub may rename it on collision and creates it asynchronously. */
async function resolveFork(repo: string, login: string, cwd: string, env: Record<string, string>): Promise<string> {
  const [, name] = repo.split("/");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const guess = await execFile("gh", ["repo", "view", `${login}/${name}`, "--json", "parent", "--jq", ".parent.nameWithOwner"], { cwd, env, timeoutMs: 60_000 });
    if (guess.exitCode === 0 && guess.output.trim() === repo) return `${login}/${name}`;
    const forks = await execFile("gh", ["api", `repos/${repo}/forks?per_page=100`, "--jq", `.[] | select(.owner.login == "${login}") | .full_name`], { cwd, env, timeoutMs: 60_000 });
    const found = forks.output.trim().split("\n")[0];
    if (forks.exitCode === 0 && found) return found;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`the fork of ${repo} for ${login} did not appear; try publishing again in a minute`);
}

/**
 * Pushes the prepared commit and opens a draft pull request with the operator's `gh` login. Callers
 * must have obtained explicit human approval before calling this.
 */
export async function publishPullRequest(opts: PublishOptions): Promise<PublishResult> {
  const { task, delivery, wsPath, env } = opts;
  const repo = `${task.repo.owner}/${task.repo.name}`;
  const log = opts.log ?? (() => undefined);
  const commands: string[] = [];
  const ghCall = opts.runner ? opts.runner.gh : (args: string[]) => gh(args, wsPath, env);
  const run = async (file: string, args: string[]): Promise<string> => {
    commands.push([file, ...args].join(" "));
    if (opts.dryRun) return "";
    if (file === "gh") return ghCall(args);
    return opts.runner ? opts.runner.push(args) : git(args, wsPath, env);
  };

  if (task.repo.host !== "github.com") throw new Error(`publishing to ${task.repo.host} is not supported yet; push ${delivery.branch} by hand`);
  if (!opts.dryRun) {
    // Publish exactly what the human read: the prepared commit, with nothing left over in the tree.
    const head = await git(["rev-parse", "HEAD"], wsPath, env);
    if (head !== delivery.commitSha) throw new Error(`workspace HEAD ${head.slice(0, 7)} is not the prepared commit ${delivery.commitSha.slice(0, 7)}; run the engine again`);
    const dirty = await git(["status", "--porcelain"], wsPath, env);
    if (dirty) throw new Error(`workspace has uncommitted changes:\n${dirty}`);
  }
  const login = opts.dryRun ? "<login>" : await ghCall(["api", "user", "--jq", ".login"]);
  const permission = opts.dryRun ? "NONE" : await ghCall(["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"]);
  const canPush = ["ADMIN", "MAINTAIN", "WRITE"].includes(permission);

  let pushUrl = `https://github.com/${repo}.git`;
  let head = delivery.branch;
  if (!canPush) {
    await run("gh", ["repo", "fork", repo, "--clone=false"]);
    const fork = opts.dryRun ? `${login}/${task.repo.name}` : await resolveFork(repo, login, wsPath, env);
    pushUrl = `https://github.com/${fork}.git`;
    head = `${fork.split("/")[0]}:${delivery.branch}`;
  }
  log(`pushing ${delivery.commitSha.slice(0, 7)} to ${pushUrl} as ${delivery.branch}`);
  // Reset any repository-local credential helper the agent could have configured, then use gh's.
  await run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", pushUrl, `${delivery.commitSha}:refs/heads/${delivery.branch}`]);

  // A retry after a partial failure (pushed, but the answer to `gh pr create` was lost) must not fail
  // on GitHub's "a pull request already exists": find the open one for this branch and return it.
  const headRef = head.includes(":") ? head : `${task.repo.owner}:${head}`;
  const existing = (await run("gh", ["api", `repos/${repo}/pulls?head=${headRef}&state=open&per_page=1`, "--jq", ".[0].html_url // empty"])).trim();
  if (existing) {
    log(`a pull request for ${headRef} is already open: ${existing}`);
    return { url: existing, head, pushedTo: pushUrl, commands };
  }
  const prArgs = ["pr", "create", "--repo", repo, "--base", task.repo.defaultBranch, "--head", head, "--title", delivery.prTitle, "--body-file", opts.bodyFile];
  if (opts.draft !== false) prArgs.push("--draft");
  const url = await run("gh", prArgs);
  return { url: url || "(dry run)", head, pushedTo: pushUrl, commands };
}
