/**
 * E2: analyze a repository as it was at T, then check at today's HEAD whether
 * each file-anchored finding was acted upon, and by whom. The baseline is
 * what happened to the issues that carried a starter label at T.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository, type ContributionOpportunity } from "@gitgoblin/intel";
import { createSources, type GitHubClient, STARTER_ISSUE_LABELS } from "@gitgoblin/sources";
import { commitAt, fetchLabeledIssues, graphqlReset, isBot, withRateLimitRetry } from "./github/history.ts";
import { seededRandom } from "./metrics.ts";
import { MAINTAINER_ASSOCIATIONS } from "./outcomes.ts";

const run = promisify(execFile);
const DAY_MS = 86_400_000;

/** Findings whose evidence comes from the live API rather than the clone at T. */
export const LIVE_KINDS: ReadonlySet<string> = new Set(["issue", "feature_request", "stale_pr", "triage", "ci_rot"]);

/**
 * `moved`: the excerpt still exists somewhere at HEAD (another file after a rename, or the same file after re-wrapping), which is not a fix.
 * `unverifiable`: the excerpt was not in the file at T either (not verbatim evidence), so nothing can be said about it.
 */
export type FindingStatus = "unchanged" | "moved" | "file_removed" | "excerpt_gone" | "unverifiable";
export type FixedBy = "outsider" | "maintainer" | "unknown";

export interface FindingOutcome {
  rank: number;
  kind: string;
  title: string;
  score: number;
  effort: string;
  path: string;
  line: number | undefined;
  excerpt: string;
  status: FindingStatus;
  /** The same grading for a random line of the same file at T: how much of the file churned anyway. */
  control?: "unchanged" | "gone" | undefined;
  /** First commit after T that removed the excerpt, when one was found. `files` is how many files it touched: a sweep of hundreds rarely targets the finding. */
  commit?: { sha: string; author: string; date: string; daysAfter: number; files: number; prNumber?: number | undefined; by: FixedBy } | undefined;
}

export interface StarterBaseline {
  openAtT: number;
  resolvedByOutsiderPr: number;
  resolvedByMaintainerPr: number;
  closedWithoutPr: number;
  stillOpen: number;
}

/** An issue-backed opportunity as it was accepted at analysis time. */
export interface AcceptedIssue {
  number: number;
  kind: string;
  rank: number;
  score: number;
  confidence: number;
  /** intel itself warned the issue may already be fixed in the code. */
  flaggedAlreadyFixed: boolean;
}

export interface IntelBacktestRow {
  id: string;
  sha: string;
  committedDate: string;
  /** When the analysis ran; issue state after this moment is the outcome. */
  analyzedAt: string;
  /** Issue-backed opportunities, graded later by `gradeIssues`. */
  issues: AcceptedIssue[];
  opportunities: number;
  liveKindsDropped: number;
  findings: FindingOutcome[];
  starter: StarterBaseline;
  notes: string[];
}

export interface IntelBacktestDataset {
  experiment: "intel-backtest";
  asOf: string;
  fetchedAt: string;
  rows: IntelBacktestRow[];
}

export interface IntelBacktestOptions {
  repos: string[];
  asOf: string;
  cacheDir: string;
  cachePath?: string | undefined;
  maxOpportunities?: number | undefined;
  log?: ((message: string) => void) | undefined;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Lowercase alphanumerics only: survives comment markers, punctuation, re-wrapping and reconstructed excerpts. */
export function skeleton(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Whether `excerpt` occurs in `content`. Tokens must match whole ("import imp" is not inside
 * "import importlib"), compared on an alphanumeric skeleton so that intel's excerpts, which drop
 * comment markers and join lines, still match the file they came from.
 */
export function containsExcerpt(content: string, excerpt: string): boolean {
  // intel truncates long excerpts with an ellipsis, so the last token may be cut mid-word.
  const truncated = /(\u2026|\.\.\.)\s*$/.test(excerpt.trim());
  const tokens = excerpt.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.join("").length < 8) return false;
  // Tokens of the content with their positions in the skeleton, so a skeleton match can be checked for token alignment.
  const contentTokens = content.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const starts = new Set<number>();
  const ends = new Set<number>();
  let pos = 0;
  for (const t of contentTokens) {
    starts.add(pos);
    pos += t.length;
    ends.add(pos);
  }
  const hay = contentTokens.join("");
  const needle = tokens.join("");
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    if (starts.has(at) && (truncated || ends.has(at + needle.length))) return true;
    from = at + 1;
  }
}

/**
 * What to search the rest of the tree for when the excerpt has left its file: a link's target
 * (a fixed link keeps its text and changes its target), else the longest distinctive run of words
 * (three or more, 16+ characters); undefined when the excerpt has neither.
 */
export function anchorPhrase(excerpt: string): string | undefined {
  const link = /\]\(\s*<?([^)\s>]+)/.exec(excerpt);
  if (link?.[1] && link[1].length >= 12) return link[1];
  const runs = excerpt.replace(/(\u2026|\.\.\.)\s*$/, "").split(/[^\w ]+/).map((r) => r.trim().replace(/\s+/g, " ")).filter((r) => r.length >= 16 && r.split(" ").length >= 3);
  return runs.sort((a, b) => b.length - a.length)[0];
}

function parseLocator(locator: string): { path: string; line: number | undefined } | undefined {
  const m = /^(.+?)(?::(\d+))?$/.exec(locator);
  if (!m || !m[1]) return undefined;
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Who merged the change: the pull request's author association when the commit came through one, else a direct push. */
async function fixedBy(github: GitHubClient, owner: string, name: string, sha: string): Promise<{ prNumber?: number | undefined; by: FixedBy }> {
  try {
    const pulls = (await github.rest(`/repos/${owner}/${name}/commits/${sha}/pulls`, { ttlMs: 30 * DAY_MS })) as { number: number; author_association: string; user?: { login: string; type: string } | null }[];
    const pr = pulls[0];
    if (!pr) return { by: "maintainer" }; // pushed directly to the default branch
    const bot = pr.user?.type === "Bot" || /\[bot\]$/i.test(pr.user?.login ?? "");
    return { prNumber: pr.number, by: bot || MAINTAINER_ASSOCIATIONS.has(pr.author_association) ? "maintainer" : "outsider" };
  } catch {
    return { by: "unknown" };
  }
}

/** A seeded random line of at least 12 characters from the file as it was at T, other than the finding's own line. */
export function controlLine(contentAtT: string, excerpt: string, seed: number): string | undefined {
  const lines = contentAtT.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && !containsExcerpt(l, excerpt) && !containsExcerpt(excerpt, l));
  if (lines.length === 0) return undefined;
  return lines[Math.floor(seededRandom(seed)() * lines.length)];
}

export async function gradeFinding(opportunity: ContributionOpportunity, rank: number, cloneDir: string, head: string, asOf: string, lookup: (sha: string) => Promise<{ prNumber?: number | undefined; by: FixedBy }>, baseSha?: string): Promise<FindingOutcome | undefined> {
  const ev = opportunity.evidence.find((e) => e.kind === "file" && e.excerpt);
  if (!ev) return undefined;
  const loc = parseLocator(ev.locator);
  if (!loc) return undefined;
  const base: Omit<FindingOutcome, "status"> = { rank, kind: opportunity.kind, title: opportunity.title, score: opportunity.score, effort: opportunity.effort, path: loc.path, line: loc.line, excerpt: ev.excerpt! };
  const content = await git(["show", `${head}:${loc.path}`], cloneDir).catch(() => undefined);
  if (baseSha) {
    const then = await git(["show", `${baseSha}:${loc.path}`], cloneDir).catch(() => undefined);
    // Evidence is meant to be verbatim; an excerpt that was never in the file cannot be graded.
    if (then !== undefined && !containsExcerpt(then, ev.excerpt!)) return { ...base, status: "unverifiable" };
    const line = then === undefined ? undefined : controlLine(then, ev.excerpt!, rank * 7919 + loc.path.length);
    if (line !== undefined) {
      const present = (content !== undefined && containsExcerpt(content, line)) || (await git(["grep", "-F", "-i", "-w", "-l", "--", anchorPhrase(line) ?? line, head], cloneDir).catch(() => "")).trim() !== "";
      base.control = present ? "unchanged" : "gone";
    }
  }
  if (content !== undefined && containsExcerpt(content, ev.excerpt!)) return { ...base, status: "unchanged" };
  const anchor = anchorPhrase(ev.excerpt!) ?? normalize(ev.excerpt!).replace(/(\u2026|\.\.\.)\s*$/, "").slice(0, 80);
  const elsewhere = await git(["grep", "-F", "-i", "-w", "-l", "--", anchor, head], cloneDir).catch(() => "");
  if (elsewhere.trim()) return { ...base, status: "moved" };
  if (content === undefined) return { ...base, status: "file_removed" };
  // `-S` lists commits that changed the number of occurrences, including ones that added one; take the first after T where the excerpt is absent.
  const candidates = async (pickaxe: boolean) =>
    (await git(["log", head, `--since=${asOf}`, "--reverse", "--format=%H%x1f%an%x1f%cI", ...(pickaxe ? ["-i", `-S${anchor.slice(0, 120)}`] : []), "--", loc.path], cloneDir).catch(() => ""))
      .split("\n").filter((l) => l.trim()).slice(0, 12);
  let first: string | undefined;
  for (const line of [...(await candidates(true)), ...(await candidates(false))]) {
    const sha = line.split("\x1f")[0]!;
    const then = await git(["show", `${sha}:${loc.path}`], cloneDir).catch(() => undefined);
    if (then === undefined || !containsExcerpt(then, ev.excerpt!)) {
      first = line;
      break;
    }
  }
  if (!first) return { ...base, status: "excerpt_gone" };
  const [sha, author, date] = first.split("\x1f") as [string, string, string];
  const files = (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], cloneDir).catch(() => "")).split("\n").filter(Boolean).length;
  const who = await lookup(sha);
  return { ...base, status: "excerpt_gone", commit: { sha, author, date, daysAfter: Math.round((Date.parse(date) - Date.parse(asOf)) / DAY_MS), files, prNumber: who.prNumber, by: who.by } };
}

/** A coarse cluster label from the title, so rates can be mapped onto the analyzers' value constants. */
export function subkind(kind: string, title: string): string {
  if (kind === "test_gap") return /skipped|expected-failure|xfail/i.test(title) ? "skipped-tests" : "untested";
  if (kind === "broken_link") return /anchor/i.test(title) ? "anchor" : /no longer exist|missing file|relative/i.test(title) ? "relative" : "external";
  if (kind === "tech_debt") return /closed issue|#\d+/i.test(title) ? "closed-ref" : /year-old/i.test(title) ? "old" : "other";
  return kind;
}

export function acceptedIssues(opportunities: ContributionOpportunity[]): AcceptedIssue[] {
  return opportunities.flatMap((o, i) => {
    if (!o.issue || !(o.kind === "issue" || o.kind === "feature_request")) return [];
    const text = [...o.risks, o.summary, ...o.evidence.map((e) => e.note ?? "")].join(" ");
    return [{ number: o.issue.number, kind: o.kind, rank: i + 1, score: o.score, confidence: o.factors.find((f) => f.name === "confidence")?.score ?? 0, flaggedAlreadyFixed: /already (be |been )?(fixed|resolved|addressed)|may be fixed|appears fixed|fixed since/i.test(text) }];
  });
}

export function starterBaseline(issues: { createdAt: string; closedAt?: string | undefined; closedByPr: "outsider" | "maintainer" | "none" }[], asOf: string): StarterBaseline {
  const t = Date.parse(asOf);
  const open = issues.filter((i) => Date.parse(i.createdAt) < t && !(i.closedAt && Date.parse(i.closedAt) < t));
  const closed = open.filter((i) => i.closedAt);
  return {
    openAtT: open.length,
    resolvedByOutsiderPr: closed.filter((i) => i.closedByPr === "outsider").length,
    resolvedByMaintainerPr: closed.filter((i) => i.closedByPr === "maintainer").length,
    closedWithoutPr: closed.filter((i) => i.closedByPr === "none").length,
    stillOpen: open.length - closed.length,
  };
}

export async function runIntelBacktest(options: IntelBacktestOptions): Promise<IntelBacktestDataset> {
  const log = options.log ?? (() => {});
  const asOf = new Date(Date.parse(options.asOf)).toISOString();
  const sources = await createSources({ cachePath: options.cachePath });
  const rows: IntelBacktestRow[] = [];
  try {
    for (const repo of options.repos) {
      const [owner, name] = repo.split("/") as [string, string];
      const notes: string[] = [];
      try {
        const at = await commitAt(sources.github, owner, name, asOf);
        if (!at) throw new Error("no commit before the as-of date");
        log(`${repo}: analyzing ${at.sha.slice(0, 10)} (${at.committedDate.slice(0, 10)})`);
        const report = await analyzeRepository({ owner, name, ref: at.sha }, { now: new Date(asOf), checkLinks: false, dependencyChecks: false, maxOpportunities: options.maxOpportunities ?? 40, cacheDir: options.cacheDir, log: (m) => log(`${repo}: ${m}`) });
        notes.push(...report.budget.notes);
        const cloneDir = `${options.cacheDir}/repos/${owner}__${name}`;
        await git(["fetch", "--quiet", "--filter=blob:none", "origin", at.branch], cloneDir);
        const head = (await git(["rev-parse", "FETCH_HEAD"], cloneDir)).trim();
        const findings: FindingOutcome[] = [];
        let dropped = 0;
        for (const [i, opp] of report.opportunities.entries()) {
          if (LIVE_KINDS.has(opp.kind)) {
            dropped++;
            continue;
          }
          const graded = await gradeFinding(opp, i + 1, cloneDir, head, asOf, (sha) => fixedBy(sources.github, owner, name, sha), at.sha);
          if (graded) findings.push(graded);
        }
        const starterIssues = await fetchLabeledIssues(sources.github, owner, name, STARTER_ISSUE_LABELS);
        const starter = starterBaseline(starterIssues, asOf);
        rows.push({ id: `github.com/${owner.toLowerCase()}/${name.toLowerCase()}`, sha: at.sha, committedDate: at.committedDate, analyzedAt: new Date().toISOString(), issues: acceptedIssues(report.opportunities), opportunities: report.opportunities.length, liveKindsDropped: dropped, findings, starter, notes });
        log(`${repo}: ${findings.length} file-anchored findings graded (${findings.filter((f) => f.status !== "unchanged").length} changed since), ${starter.openAtT} starter issues open at T`);
      } catch (error) {
        log(`${repo}: skipped: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    sources.close();
  }
  return { experiment: "intel-backtest", asOf, fetchedAt: new Date().toISOString(), rows };
}

/** `open_with_merged_pr`: still open although a pull request that claims to close it has merged, the drift case intel's "already fixed?" check targets. */
export type IssueFate = "open" | "open_with_merged_pr" | "completed_by_pr" | "completed_without_pr" | "not_planned" | "duplicate" | "closed_unknown";

export interface IssueOutcome extends AcceptedIssue {
  fate: IssueFate;
  closedAt?: string | undefined;
  /** When the closing pull request merged; before `analyzedAt` means intel accepted an issue that was already fixed. */
  fixedAt?: string | undefined;
  fixedBeforeRun: boolean;
  fixedBy?: "outsider" | "maintainer" | undefined;
}

export interface IssueState {
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | null;
  closedAt: string | null;
  closingPrs: { mergedAt: string | null; authorAssociation: string; authorIsBot: boolean }[];
}

export function gradeIssue(issue: AcceptedIssue, analyzedAt: string, state: IssueState | undefined): IssueOutcome {
  if (!state) return { ...issue, fate: "open", fixedBeforeRun: false };
  const merged = state.closingPrs.filter((p) => p.mergedAt).sort((a, b) => a.mergedAt!.localeCompare(b.mergedAt!));
  const first = merged[0];
  const fixedAt = first?.mergedAt ?? undefined;
  const base = { ...issue, closedAt: state.closedAt ?? undefined, fixedAt, fixedBeforeRun: fixedAt !== undefined && fixedAt < analyzedAt, fixedBy: first ? (first.authorIsBot || MAINTAINER_ASSOCIATIONS.has(first.authorAssociation) ? "maintainer" as const : "outsider" as const) : undefined };
  if (state.state === "OPEN") return { ...base, fate: first ? "open_with_merged_pr" : "open" };
  if (state.stateReason === "COMPLETED") return { ...base, fate: first ? "completed_by_pr" : "completed_without_pr" };
  if (state.stateReason === "NOT_PLANNED") return { ...base, fate: "not_planned" };
  if (state.stateReason === "DUPLICATE") return { ...base, fate: "duplicate" };
  return { ...base, fate: "closed_unknown" };
}

/** Current state of the accepted issues, ten per query. */
export async function fetchIssueStates(github: GitHubClient, owner: string, name: string, numbers: number[]): Promise<Map<number, IssueState>> {
  const result = new Map<number, IssueState>();
  for (let start = 0; start < numbers.length; start += 10) {
    const batch = numbers.slice(start, start + 10);
    const selections = batch.map((n, i) => `i${i}: issue(number: ${n}) { number state stateReason closedAt closedByPullRequestsReferences(first: 3) { nodes { mergedAt authorAssociation author { login __typename } } } }`).join("\n");
    const query = `query IssueStates($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selections} } }`;
    const data = await withRateLimitRetry(
      () => github.graphql<{ repository: Record<string, { number: number; state: "OPEN" | "CLOSED"; stateReason: IssueState["stateReason"]; closedAt: string | null; closedByPullRequestsReferences: { nodes: { mergedAt: string | null; authorAssociation: string; author: { login: string; __typename: string } | null }[] } } | null> | null }>(query, { owner, name }, { ttlMs: 24 * 3_600_000 }),
      () => {},
      graphqlReset(github),
    );
    for (const node of Object.values(data.repository ?? {})) {
      if (!node) continue;
      result.set(node.number, { state: node.state, stateReason: node.stateReason, closedAt: node.closedAt, closingPrs: node.closedByPullRequestsReferences.nodes.map((p) => ({ mergedAt: p.mergedAt, authorAssociation: p.authorAssociation, authorIsBot: isBot(p.author) })) });
    }
  }
  return result;
}

export interface IssueGradingDataset {
  experiment: "intel-issues";
  source: string;
  fetchedAt: string;
  rows: { id: string; analyzedAt: string; issues: IssueOutcome[] }[];
}

export async function gradeIssues(dataset: IntelBacktestDataset, options: { cachePath?: string | undefined; log?: ((m: string) => void) | undefined }): Promise<IssueGradingDataset> {
  const log = options.log ?? (() => {});
  const sources = await createSources({ cachePath: options.cachePath });
  const rows: IssueGradingDataset["rows"] = [];
  try {
    for (const row of dataset.rows) {
      if (!row.issues?.length) continue;
      const [, owner, name] = row.id.split("/") as [string, string, string];
      try {
        const states = await fetchIssueStates(sources.github, owner, name, row.issues.map((i) => i.number));
        const issues = row.issues.map((i) => gradeIssue(i, row.analyzedAt, states.get(i.number)));
        rows.push({ id: row.id, analyzedAt: row.analyzedAt, issues });
        log(`${row.id}: ${issues.length} accepted issues, ${issues.filter((i) => i.fate !== "open").length} closed since, ${issues.filter((i) => i.fixedBeforeRun).length} fixed before the run`);
      } catch (error) {
        log(`${row.id}: skipped: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    sources.close();
  }
  return { experiment: "intel-issues", source: dataset.fetchedAt, fetchedAt: new Date().toISOString(), rows };
}

/** Re-grades the stored findings of a dataset against HEAD today, from the clones intel left behind, without re-running the analysis. */
export async function regradeDataset(dataset: IntelBacktestDataset, options: { cacheDir: string; cachePath?: string | undefined; log?: ((m: string) => void) | undefined }): Promise<IntelBacktestDataset> {
  const log = options.log ?? (() => {});
  const sources = await createSources({ cachePath: options.cachePath });
  const rows: IntelBacktestRow[] = [];
  try {
    for (const row of dataset.rows) {
      const [, owner, name] = row.id.split("/") as [string, string, string];
      const cloneDir = `${options.cacheDir}/repos/${owner}__${name}`;
      try {
        const branch = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cloneDir)).trim().replace(/^origin\//, "");
        await git(["fetch", "--quiet", "--filter=blob:none", "origin", branch], cloneDir);
        const head = (await git(["rev-parse", "FETCH_HEAD"], cloneDir)).trim();
        const findings: FindingOutcome[] = [];
        for (const f of row.findings) {
          const synthetic = { kind: f.kind, title: f.title, score: f.score, effort: f.effort, evidence: [{ id: "e", kind: "file", locator: f.line === undefined ? f.path : `${f.path}:${f.line}`, excerpt: f.excerpt, observedAt: dataset.asOf }] } as unknown as ContributionOpportunity;
          const graded = await gradeFinding(synthetic, f.rank, cloneDir, head, dataset.asOf, (sha) => fixedBy(sources.github, owner, name, sha), row.sha);
          if (graded) findings.push(graded);
        }
        rows.push({ ...row, findings });
        log(`${row.id}: ${findings.length} findings regraded`);
      } catch (error) {
        rows.push(row);
        log(`${row.id}: kept as is: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    sources.close();
  }
  return { ...dataset, fetchedAt: new Date().toISOString(), rows };
}
