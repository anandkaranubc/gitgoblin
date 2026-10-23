import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { GitHubError } from "../github/client.ts";
import { compareVersions } from "../manifests/python.ts";
import { daysAgo } from "../util/time.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

export interface DebtMarker {
  path: string;
  line: number;
  marker: string;
  text: string;
  /** Issue numbers referenced in the comment. */
  issues: number[];
}

const MARKER = /(?:^|[#/*;%!<-]\s*|\s)(TODO|FIXME|HACK|XXX|BUG)\b(?:\s*\([^)]*\))?\s*:?-?\s*/;
const COMMENT_TOKEN = /(^|\s)(#|\/\/|\/\*|\*|--|<!--|;;|%|!)/;
const SOURCE_EXT = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|dart|ex|exs|scala|lua|sh|m|hs|ml|clj|r|jl)$/i;

export function findDebtMarkers(path: string, text: string): DebtMarker[] {
  const out: DebtMarker[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = MARKER.exec(line);
    if (!m || !COMMENT_TOKEN.test(line) || /^\s*(import|from|def|class|function|const|let|var)\b/.test(line)) continue;
    const after = line.slice(m.index + m[0].length).replace(/\*\/\s*$|-->\s*$/, "").trim();
    const issues = [...line.matchAll(/(?:#|GH-|issues\/|issue\s)(\d{1,6})\b/gi)].map((x) => Number(x[1]));
    out.push({ path, line: i + 1, marker: m[1]!.toUpperCase(), text: after, issues });
  }
  return out;
}

/** Minimum Python minor version the project claims, from requires-python or classifiers. */
export function minimumPython(requires: string | undefined, classifiers: string[]): string | undefined {
  if (requires) {
    const m = /(?:>=|~=|\^)\s*(\d\.\d+)/.exec(requires) ?? /^\s*(\d\.\d+)/.exec(requires);
    if (m) return m[1];
  }
  return classifiers[0];
}

/** "remove when we drop 3.7" style notes whose condition is already met. */
export function pythonVersionConditionMet(text: string, minimum: string | undefined): string | undefined {
  if (!minimum) return undefined;
  if (!/\b(drop|remov|once|when|after|until|support|min(imum)?|require|only|upgrade|bump)/i.test(text)) return undefined;
  // Require an explicit Python mention: bare "3.0" usually means the project's own version.
  const m = /\bpy(?:thon)?\s*(?:-|\s)?3\.(\d{1,2})\b|\bpy3(\d{1,2})\b|\bpython\s*(?:<|<=|older than|before)\s*3\.(\d{1,2})\b/i.exec(text);
  if (m && m[3]) return compareVersions(`3.${m[3]}`, minimum) <= 0 ? `3.${Number(m[3]) - 1}` : undefined;
  if (!m) return undefined;
  const mentioned = `3.${m[1] ?? m[2]}`;
  return compareVersions(mentioned, minimum) < 0 ? mentioned : undefined;
}

export const techDebtAnalyzer: Analyzer = {
  name: "tech-debt",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (["awesome_list", "docs", "config", "tutorial", "data", "template"].includes(profile.nature)) return [];
    const markers: DebtMarker[] = [];
    for await (const { path, text } of textFiles(ctx, (p) => SOURCE_EXT.test(p) && ctx.inventory.byPath.get(p)?.category === "source", 1500)) {
      markers.push(...findDebtMarkers(path, text));
      if (markers.length > 600) {
        ctx.budget.cut("stopped collecting TODO markers after 600");
        break;
      }
    }
    if (markers.length === 0) return [];
    const findings: Finding[] = [];
    const python = ctx.manifests.python;
    const minPy = python ? minimumPython(python.requiresPython, python.classifierVersions) : undefined;

    // (a) TODOs that cite an issue which has since been closed.
    const withIssues = markers.filter((m) => m.issues.length > 0).slice(0, 15);
    const issueState = new Map<number, { state: string; reason: string | undefined; url: string; title: string; closedAt: string | undefined }>();
    if (ctx.github && withIssues.length > 0) {
      for (const n of new Set(withIssues.flatMap((m) => m.issues))) {
        try {
          const issue = await ctx.github.rest<{ state: string; state_reason: string | null; html_url: string; title: string; closed_at: string | null; pull_request?: unknown }>(`/repos/${ctx.ref.owner}/${ctx.ref.name}/issues/${n}`);
          issueState.set(n, { state: issue.state, reason: issue.state_reason ?? undefined, url: issue.html_url, title: issue.title, closedAt: issue.closed_at ?? undefined });
        } catch (error) {
          if (!(error instanceof GitHubError)) throw error;
          if (error.status === 429) break;
        }
      }
    }
    for (const m of withIssues) {
      const closed = m.issues.map((n) => issueState.get(n)).find((s) => s?.state === "closed");
      if (!closed) continue;
      const n = m.issues.find((x) => issueState.get(x) === closed)!;
      findings.push({
        kind: "tech_debt",
        clusterKey: "todo-closed-issue",
        title: "Clean up TODOs that reference issues which are already closed",
        summary: "Comments say to revisit code once an issue is resolved; those issues are closed, so the workaround or note is stale.",
        evidence: [
          evidence(ctx, "file", `${m.path}:${m.line}`, { excerpt: `${m.marker}: ${m.text}` }),
          evidence(ctx, "issue", closed.url, { note: `#${n} "${closed.title}" closed${closed.reason ? ` as ${closed.reason.replace("_", " ")}` : ""}${closed.closedAt ? ` on ${closed.closedAt.slice(0, 10)}` : ""}` }),
        ],
        files: [m.path],
        effort: "small",
        skills: [ctx.inventory.byPath.get(m.path)?.language?.toLowerCase() ?? "code"],
        approach: [`Read #${n} to learn how it was resolved.`, closed.reason === "not_planned" ? "The issue was closed as not planned: update the comment to explain the permanent state, or remove the dead branch." : "Remove the workaround if the fix makes it unnecessary, keeping behaviour identical; otherwise update the comment.", "Run the test suite."],
        acceptanceCriteria: ["The comment no longer points at a closed issue, and behaviour is unchanged or covered by tests."],
        risks: ["The issue may have been closed without a real fix; verify before deleting code."],
        signals: { value: 0.4, valueReason: "removes a stale workaround and misleading comment", feasibility: 0.75, feasibilityReason: "the issue thread documents the resolution", confidence: 0.9, confidenceReason: "issue state confirmed through the API", welcomenessFactor: 0.85 },
      });
    }

    // (b) TODOs about dropping a Python version the project already dropped.
    for (const m of markers) {
      const mentioned = pythonVersionConditionMet(m.text, minPy);
      if (!mentioned) continue;
      findings.push({
        kind: "tech_debt",
        clusterKey: "todo-python-version",
        title: `Remove compatibility code kept for Python ${mentioned}, which is no longer supported`,
        summary: `Comments say to clean up once Python ${mentioned} support is dropped; the project now requires Python ${minPy} or newer, so the condition is met.`,
        evidence: [
          evidence(ctx, "file", `${m.path}:${m.line}`, { excerpt: `${m.marker}: ${m.text}` }),
          evidence(ctx, "file", python!.paths[0]!, { note: `minimum Python is ${minPy} (${python!.requiresPython ? `requires-python ${python!.requiresPython}` : "from classifiers"})` }),
        ],
        files: [m.path, python!.paths[0]!],
        effort: "small",
        skills: ["python"],
        approach: ["Delete the compatibility branch and any now-unused imports.", "Run the test suite on the minimum supported Python."],
        acceptanceCriteria: ["Tests pass on the minimum supported Python; no behaviour change."],
        signals: { value: 0.45, valueReason: "dead compatibility code is pure maintenance cost", feasibility: 0.85, feasibilityReason: "the comment names exactly what to remove", confidence: 0.8, confidenceReason: "version in the comment is below requires-python", welcomenessFactor: 0.9 },
      });
    }

    // (c) A few specific, old markers worth asking about. Low confidence by design.
    const generic = markers
      .filter((m) => m.issues.length === 0 && m.text.length >= 40 && !pythonVersionConditionMet(m.text, minPy))
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, 20);
    let emitted = 0;
    for (const m of generic) {
      if (emitted >= 3) break;
      // blame in a blob:none clone fetches one blob per revision; skip files with long histories.
      if ((await ctx.repo.revisionCount(m.path)) > 15) continue;
      const blame = await ctx.repo.blameLine(m.path, m.line);
      if (!blame || daysAgo(blame.date, ctx.now) < 365) continue;
      emitted++;
      const age = Math.round(daysAgo(blame.date, ctx.now) / 365 * 10) / 10;
      findings.push({
        kind: "tech_debt",
        clusterKey: `todo:${m.path}:${m.line}`,
        title: `Resolve a ${age}-year-old ${m.marker} in ${m.path}`,
        summary: `${m.marker}: ${m.text}`,
        evidence: [evidence(ctx, "file", `${m.path}:${m.line}`, { excerpt: `${m.marker}: ${m.text}` }), evidence(ctx, "commit", blame.sha, { note: `line last changed ${blame.date.slice(0, 10)}` })],
        files: [m.path],
        effort: "medium",
        skills: [ctx.inventory.byPath.get(m.path)?.language?.toLowerCase() ?? "code"],
        approach: ["Open an issue quoting the comment and proposing how to resolve it; wait for a maintainer to confirm it is still wanted.", "Implement with tests covering the previously-noted gap."],
        acceptanceCriteria: ["The comment is removed because the underlying problem is fixed, with maintainer agreement."],
        etiquette: ["Ask before doing: old TODOs are sometimes deliberately deferred."],
        risks: ["Maintainers may have reasons to leave it; the comment may be outdated."],
        signals: { value: 0.35, valueReason: "self-admitted debt the authors wanted fixed", feasibility: 0.5, feasibilityReason: "scope depends on the comment's accuracy", confidence: 0.4, confidenceReason: "the marker is real, but whether it is still wanted is unknown", welcomenessFactor: 0.7 },
      });
    }
    return findings;
  },
};

function rank(m: DebtMarker): number {
  return (m.marker === "FIXME" || m.marker === "BUG" ? 2 : m.marker === "HACK" ? 1.5 : 1) * Math.min(m.text.length, 120);
}
