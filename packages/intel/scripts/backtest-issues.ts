#!/usr/bin/env node
/**
 * Grade the issue classifier against maintainers' own decisions.
 *
 * For each recently closed issue, run the lexical assessment as it would have
 * run while the issue was open (clock set to the close time, comments from the
 * last two days before closing removed so the closing rationale cannot leak),
 * then compare with GitHub's state reason: COMPLETED means the issue was worth
 * acting on; NOT_PLANNED and DUPLICATE mean it was not.
 *
 * Usage: node scripts/backtest-issues.ts owner/name [owner/name...] [--issues 200] [--show fp|fn]
 */
import { parseArgs } from "node:util";

import { assessIssue } from "../src/analyzers/issues.ts";
import { shrinking, mapIssueNode } from "../src/github/fetch.ts";
import { FetchGitHubApi, type GitHubApi, discoverToken } from "../src/github/client.ts";
import { sharedGitHubApi } from "../src/github/sources-adapter.ts";
import { CLOSED_ISSUES_FULL_QUERY } from "../src/github/queries.ts";
import type { IssueSample } from "../src/github/types.ts";

interface Row { repo: string; n: number; completed: number; notPlanned: number; tp: number; fp: number; fpDup: number; fn: number; tn: number; triage: number }

const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { issues: { type: "string", default: "200" }, show: { type: "string" } } });
// The shared client caches on disk, which keeps repeated backtests off GitHub's secondary rate limit.
const api: GitHubApi = (await sharedGitHubApi()) ?? new FetchGitHubApi({ token: await discoverToken() });

/** One retry after a pause when GitHub reports a secondary rate limit (403 or 429), waiting until the reported reset when known. */
async function graphqlWithBackoff<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await api.graphql<T>(query, variables);
  } catch (error) {
    const e = error as { status?: number; message?: string; resetAt?: Date };
    const limited = (e.status === 403 || e.status === 429) && /rate limit/i.test(e.message ?? "");
    if (!limited) throw error;
    const waitMs = Math.min(5 * 60_000, Math.max(70_000, e.resetAt instanceof Date ? e.resetAt.getTime() - Date.now() + 5_000 : 0));
    console.error(`rate limit hit; waiting ${Math.round(waitMs / 1000)} s`);
    await new Promise((r) => setTimeout(r, waitMs));
    return api.graphql<T>(query, variables);
  }
}
const want = Number(values.issues);
const rows: Row[] = [];

for (const repo of positionals) {
  const [owner, name] = repo.split("/") as [string, string];
  const issues: (IssueSample & { stateReason: string | null })[] = [];
  let after: string | null = null;
  while (issues.length < want) {
    const page = await shrinking(Math.min(50, want - issues.length), (first) => graphqlWithBackoff<{ repository: { issues: { pageInfo: { endCursor: string; hasNextPage: boolean }; nodes: unknown[] } } | null }>(CLOSED_ISSUES_FULL_QUERY, { owner, name, first, after }), (d) => d.repository?.issues.nodes);
    await new Promise((r) => setTimeout(r, 400));
    const conn = page.data.repository?.issues;
    for (const node of page.nodes) issues.push({ ...mapIssueNode(node), stateReason: (node as { stateReason: string | null }).stateReason });
    if (!conn?.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const row: Row = { repo, n: 0, completed: 0, notPlanned: 0, tp: 0, fp: 0, fpDup: 0, fn: 0, tn: 0, triage: 0 };
  for (const issue of issues) {
    const reason = issue.stateReason ?? "";
    const worth = reason === "COMPLETED";
    const notWorth = reason === "NOT_PLANNED" || reason === "DUPLICATE";
    if (!worth && !notWorth) continue; // closed without a reason: no verdict to grade against
    if (!issue.closedAt || issue.author?.isBot) continue;
    const closedAt = new Date(issue.closedAt);
    const cutoff = closedAt.getTime() - 48 * 3_600_000;
    const asOpen: IssueSample = {
      ...issue,
      closedAt: undefined,
      locked: false, // bots lock issues when closing; the lock did not exist while it was open
      lastComments: issue.lastComments.filter((c) => Date.parse(c.createdAt) < cutoff),
      firstComments: issue.firstComments.filter((c) => Date.parse(c.createdAt) < cutoff),
      // A PR that closed the issue is hindsight; drop merged links.
      linkedPrs: issue.linkedPrs.filter((p) => p.state !== "MERGED" && Date.parse(p.updatedAt) < cutoff),
    };
    const a = assessIssue(asOpen, closedAt, true, `https://github.com/${owner}/${name}`);
    row.n++;
    if (worth) row.completed++; else row.notPlanned++;
    if (!a.skipReason && a.kind === "triage") { row.triage++; continue; }
    const accepted = !a.skipReason;
    if (accepted && worth) row.tp++;
    else if (accepted && notWorth) { row.fp++; if (reason === "DUPLICATE") row.fpDup++; }
    else if (!accepted && worth) row.fn++;
    else row.tn++;
    if (values.show === "fp" && accepted && notWorth) console.log(`FP ${repo}#${issue.number} [${reason}] kind=${a.kind} labels=${issue.labels.join(",") || "-"} comments=${issue.commentCount} :: ${issue.title.slice(0, 80)}`);
    if (values.show === "fn" && !accepted && worth) console.log(`FN ${repo}#${issue.number} skip=${(a.skipReason ?? "").slice(0, 60)} labels=${issue.labels.join(",") || "-"} :: ${issue.title.slice(0, 70)}`);
  }
  rows.push(row);
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
console.log("repo | graded | completed | not planned/dup | accepted | precision | precision excl. duplicates | recall | triage");
let T = { n: 0, completed: 0, notPlanned: 0, tp: 0, fp: 0, fpDup: 0, fn: 0, tn: 0, triage: 0 };
for (const r of rows) {
  const accepted = r.tp + r.fp;
  console.log(`${r.repo} | ${r.n} | ${r.completed} | ${r.notPlanned} | ${accepted} | ${pct(r.tp, accepted)} | ${pct(r.tp, accepted - r.fpDup)} | ${pct(r.tp, r.completed)} | ${r.triage}`);
  for (const k of Object.keys(T) as (keyof typeof T)[]) T[k] += r[k];
}
const base = pct(T.completed, T.n);
console.log(`ALL | ${T.n} | ${T.completed} | ${T.notPlanned} | ${T.tp + T.fp} | ${pct(T.tp, T.tp + T.fp)} | ${pct(T.tp, T.tp + T.fp - T.fpDup)} | ${pct(T.tp, T.completed)} | ${T.triage}`);
console.log(`\nBase rate of "completed" among graded issues: ${base}. Precision above the base rate means the classifier adds information.`);
console.log(`API requests: ${api.stats.requests}`);
