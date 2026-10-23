/**
 * Has the code an issue talks about moved on since it was filed? An open issue is not
 * proof of an open problem: fixes land without closing references, and reporters rarely
 * come back to confirm. Two cheap checks from the clone catch many of those cases before
 * anyone spends an afternoon (or an agent run) on a fixed bug.
 *
 * 1. Code the issue quotes (fenced blocks, Python traceback source lines, permalinked line
 *    ranges) that existed in the files it names when it was filed and is gone at HEAD.
 * 2. Commits that touched those files since filing, with or without a reference to the issue.
 */
import type { AnalysisContext } from "../context.ts";
import type { IssueSample } from "../github/types.ts";
import { truncate, trimEnd } from "../util/text.ts";
import { type Finding, evidence } from "./types.ts";

export interface IssueDrift {
  /** Quoted lines present in a named file at filing time and absent at HEAD. */
  gone: { line: string; file: string }[];
  /** Quoted lines still found at HEAD. */
  present: number;
  /** Commits touching the named files since filing. */
  commits: { sha: string; date: string; subject: string }[];
  /** Commits among those whose subject references the issue. */
  referencing: { sha: string; date: string; subject: string }[];
  files: string[];
}

const MAX_QUOTED_LINES = 8;
const MAX_FILES = 6;
/** A quoted line found in more files than this is boilerplate, not a location. */
const GENERIC_HITS = 5;

const SHELL_OR_OUTPUT = /^(>>>|\.\.\.|\$ |% |#!|pip |python|npm |npx |yarn |git |Traceback|File "|at |\s*\^+$|Error|\w+Error:)/;
const IMPORT_ONLY = /^(import\s+[\w.]+|from\s+[\w.]+\s+import\s+[\w.*, ]+|#include\s*[<"]|use\s+[\w:]+;|package\s+\w+|require\(.*\)|const .* = require\(.*\);?)$/;

/** Lines from fenced code blocks distinctive enough to look up: code-shaped, not prompts, output or bare imports. */
export function quotedCodeLines(body: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const raw of body.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (marker) {
      const [, ticks, rest] = marker as unknown as [string, string, string];
      if (!fence) {
        if (rest.includes(ticks[0]!.repeat(3))) continue; // ```foo``` on one line is inline code, not a block
        fence = ticks;
        continue;
      }
      if (ticks[0] === fence[0] && ticks.length >= fence.length && rest.trim() === "") {
        fence = undefined;
        continue;
      }
    }
    if (!fence) continue;
    const line = raw.trim();
    if (!distinctive(line) || SHELL_OR_OUTPUT.test(line) || IMPORT_ONLY.test(line)) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length >= MAX_QUOTED_LINES) break;
  }
  return out;
}

/** Python traceback frames: the file path and the source line printed under it. */
export function tracebackFrames(body: string): { path: string; line: string }[] {
  const out: { path: string; line: string }[] = [];
  // Horizontal whitespace only: a multiline `^\s*` would rescan every following blank line.
  const frame = /^[ \t]*File "([^"\n]{1,500})", line \d+, in [^\n]+\n(?![ \t]*File ")[ \t]+([^\n]+)/gm;
  for (const m of body.matchAll(frame)) {
    const line = m[2]!.trim();
    if (line.length >= 8) out.push({ path: m[1]!, line });
  }
  return out;
}

export interface Permalink {
  path: string;
  /** Commit id or ref the link pins. */
  rev: string;
  /** 1-based inclusive line range when the link has a #L anchor. */
  lines?: [number, number] | undefined;
}

/** Links into this repository's own files (blob/blame URLs), with their revision and line range. */
export function permalinks(text: string, ref: { host: string; owner: string; name: string }): Permalink[] {
  const out: Permalink[] = [];
  const re = new RegExp(`https?://${escapeRe(ref.host)}/${escapeRe(ref.owner)}/${escapeRe(ref.name)}/(?:-/)?(?:blob|blame)/([^/\\s#)]+)/([^\\s#)]+?)(?:#L(\\d+)(?:-L?(\\d+))?)?(?=[\\s)\\]"'<>]|$)`, "gi");
  for (const m of text.matchAll(re)) {
    const path = decodeURIComponent(m[2]!).replace(/\/+$/, "");
    if (!path || out.some((p) => p.path === path && p.rev === m[1])) continue;
    const a = m[3] ? Number(m[3]) : undefined;
    const b = m[4] ? Number(m[4]) : a;
    out.push({ path, rev: m[1]!, lines: a ? [Math.min(a, b!), Math.max(a, b!)] : undefined });
    if (out.length >= 5) break;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_PERMALINK_LINES = 12;

/**
 * Is a quoted line still in the tree? Exact first; then without its closing punctuation, so a
 * line that merely grew a call or an argument (`echo(x())` becoming `echo(x().encode())`) counts
 * as edited in place rather than gone.
 */
async function stillPresent(ctx: AnalysisContext, line: string, paths: string[] = []): Promise<string[]> {
  const hits = await ctx.repo.grepExact(line, { paths });
  if (hits.length) return hits;
  const relaxed = trimEnd(line, " \t\n)];,:.");
  if (relaxed.length >= 12 && relaxed !== line) {
    const again = await ctx.repo.grepExact(relaxed, { paths });
    if (again.length) return again;
  }
  // A line that kept its first two thirds gained an argument or a clause (`validate_json(a, b)` to `validate_json(a, b, c)`).
  const prefix = trimEnd(line.slice(0, Math.floor(line.length * 0.66)), " \t\n,(");
  if (prefix.length < 20) return [];
  return ctx.repo.grepExact(prefix, { paths });
}

/** Code-shaped enough to look up: an identifier, some punctuation, and not a lone token or closing bracket. */
function distinctive(line: string): boolean {
  return line.length >= 16 && line.length <= 200 && /[A-Za-z_]\w{2,}/.test(line) && /[^\w\s]/.test(line) && !/^[)\]}]+[;,]?$/.test(line);
}

/** Map an absolute or site-packages path from a traceback to a tracked file, if any. */
function repoPathFor(ctx: AnalysisContext, path: string): string | undefined {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  // Longest suffix that is a tracked file wins; a bare file name alone is too ambiguous.
  for (let n = Math.min(parts.length, 5); n >= 2; n--) {
    const suffix = parts.slice(parts.length - n).join("/");
    if (ctx.inventory.byPath.has(suffix)) return suffix;
    const hit = ctx.inventory.files.find((f) => !f.vendored && f.path.endsWith(`/${suffix}`));
    if (hit) return hit.path;
  }
  return undefined;
}

export async function assessIssueDrift(ctx: AnalysisContext, issue: IssueSample, namedFiles: string[]): Promise<IssueDrift | undefined> {
  const files = [...namedFiles];
  const links = permalinks(issue.body, ctx.ref).filter((l) => ctx.inventory.byPath.has(l.path) || /^[0-9a-f]{7,40}$/i.test(l.rev));
  for (const l of links) if (!files.includes(l.path) && files.length < MAX_FILES) files.push(l.path);
  const frames = tracebackFrames(issue.body)
    .map((f) => ({ path: repoPathFor(ctx, f.path), line: f.line }))
    .filter((f): f is { path: string; line: string } => f.path !== undefined);
  for (const f of frames) if (!files.includes(f.path) && files.length < MAX_FILES) files.push(f.path);
  const quoted = quotedCodeLines(issue.body);
  if (!files.length && !quoted.length) return undefined;

  // Lines a permalink points at were in the file at that commit by definition; absent at HEAD means changed.
  const gone: IssueDrift["gone"] = [];
  let present = 0;
  for (const l of links) {
    if (!l.lines || !/^[0-9a-f]{7,40}$/i.test(l.rev)) continue;
    const text = await ctx.repo.showFile(l.rev, l.path);
    if (text === undefined) continue;
    const [a, b] = l.lines;
    const linked = text.split("\n").slice(a - 1, Math.min(b, a - 1 + MAX_PERMALINK_LINES)).map((s) => s.trim()).filter(distinctive);
    for (const line of linked) {
      const hits = await stillPresent(ctx, line, [l.path]);
      if (hits.length) present++;
      else if (!gone.some((g) => g.line === line)) gone.push({ line, file: l.path });
    }
  }

  const absent: string[] = [];
  for (const line of quoted) {
    const hits = await stillPresent(ctx, line);
    if (hits.length === 0) absent.push(line);
    else if (hits.length <= GENERIC_HITS) {
      present++;
      for (const hit of hits) if (!files.includes(hit) && files.length < MAX_FILES) files.push(hit);
    }
  }
  for (const f of frames) {
    const hits = await stillPresent(ctx, f.line, [f.path]);
    if (hits.length) present++;
    else if (!absent.includes(f.line)) absent.push(f.line);
  }

  if (absent.length && files.length) {
    const rev = await ctx.repo.revBefore(issue.createdAt);
    if (rev) {
      for (const line of absent) {
        const was = await ctx.repo.grepExact(line, { paths: files, rev });
        if (was.length) gone.push({ line, file: was[0]! });
      }
    }
  }

  const commits = files.length ? (await ctx.repo.log({ since: issue.createdAt, paths: files, maxCount: MAX_COMMITS })).map((c) => ({ sha: c.sha, date: c.date, subject: c.subject })) : [];
  const mention = new RegExp(`(^|[^\\w])(#|GH-|gh-)${issue.number}(?!\\d)`);
  const referencing = commits.filter((c) => mention.test(c.subject));
  return { gone, present, commits, referencing, files };
}

const MAX_COMMITS = 40;
/** Fewer commits than this on the named files is ordinary maintenance, not worth a warning. */
const MIN_COMMITS_TO_MENTION = 5;

/** Fold the drift into the finding: a risk the reader sees, lower confidence and value, and evidence they can check. */
export function applyIssueDrift(ctx: AnalysisContext, finding: Finding, issue: IssueSample, drift: IssueDrift): void {
  const risks = finding.risks ?? [];
  const since = issue.createdAt.slice(0, 10);
  if (drift.referencing.length) {
    const c = drift.referencing[0]!;
    risks.unshift(`Commit ${c.sha.slice(0, 7)} (${c.date.slice(0, 10)}, "${truncate(c.subject, 70)}") mentions #${issue.number}; the issue may already be addressed and simply left open.`);
    finding.evidence.push(evidence(ctx, "commit", c.sha, { excerpt: c.subject, note: `touched ${drift.files.slice(0, 2).join(", ")} after #${issue.number} was filed and names it` }));
    scaleConfidence(finding, 0.5, "a later commit references the issue");
    scaleValue(finding, 0.75, "may already be addressed");
  } else if (drift.gone.length) {
    const g = drift.gone[0]!;
    const n = drift.commits.length >= MAX_COMMITS ? `${MAX_COMMITS} or more commits` : `${drift.commits.length} commit${drift.commits.length === 1 ? "" : "s"}`;
    risks.unshift(`Code quoted in the issue ("${truncate(g.line, 60)}") was in ${g.file} when it was filed and is gone at HEAD; it may already be fixed. Read the ${n} touching that file since ${since} first.`);
    finding.evidence.push(evidence(ctx, "file", g.file, { excerpt: g.line, note: `quoted in #${issue.number}; present on ${since}, absent at HEAD` }));
    scaleConfidence(finding, 0.6, "code the issue quotes has changed since it was filed");
    scaleValue(finding, 0.75, "may already be fixed");
  } else if (drift.commits.length >= MIN_COMMITS_TO_MENTION && drift.present === 0) {
    // Churn on the named files says "check first", not "probably fixed": a note for the reader, no change to the score.
    const n = drift.commits.length >= MAX_COMMITS ? `${MAX_COMMITS} or more commits` : `${drift.commits.length} commits`;
    risks.push(`${n} touched ${drift.files.slice(0, 2).join(" and ")} since the issue was filed (${since}), none referencing it; confirm it still reproduces at HEAD.`);
  }
  finding.risks = risks;
}

function scaleValue(finding: Finding, factor: number, why: string): void {
  finding.signals.value = Math.max(0.1, Math.round(finding.signals.value * factor * 100) / 100);
  finding.signals.valueReason = `${finding.signals.valueReason}; ${why}`;
}

function scaleConfidence(finding: Finding, factor: number, why: string): void {
  finding.signals.confidence = Math.max(0.1, Math.round(finding.signals.confidence * factor * 100) / 100);
  finding.signals.confidenceReason = `${finding.signals.confidenceReason}; ${why}`;
}
