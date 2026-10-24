/**
 * Are the issues intel accepts, and the ones it ranks first, the ones outsiders actually fix?
 *
 * For each repository: take every issue that was open on a past date T, reconstruct it as it looked then
 * (`issueAsOf`), run the issue classifier and intel's issue score with the clock at T, and look at what happened in
 * the following window. The outcome is "closed as completed by a merged pull request from an outsider". Two readings
 * of outsider are reported:
 *
 * - association: the pull request's author is not OWNER, MEMBER or COLLABORATOR, and not a bot;
 * - strict: also not the issue's own reporter (a newcomer could not have taken that issue), and not an author with
 *   four or more closing pull requests in that repository's window (staff whose organization membership is private
 *   show up as CONTRIBUTOR).
 *
 * Two questions are answered on the same issues. Selection: how often are intel's accepted issues fixed by outsiders,
 * against all open issues, starter-labelled issues and issues a maintainer had commented on? Ranking: within each
 * repository, do accepted issues that intel scores higher get fixed by outsiders more often (pairwise AUC, and hits
 * in the top 3, 5 and 10 against what picking at random among accepted issues would give)?
 *
 * Usage: node scripts/backtest-outcomes.ts owner/name [owner/name...] [--at 2026-05-27] [--horizon 120] [--pages 8] [--dump rows.jsonl]
 *
 * Limits, stated in the report: labels, assignees and reactions are today's; the reconstruction sees the first three
 * and last six comments, as intel's sample does; open issues are read newest-updated first, so the stalest open issues
 * of large trackers are missing.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { issueSignals } from "../src/analyzers/issues.ts";
import { type BacktestIssue, assessIssue, fetchIssueSamples, issueAsOf, issueScore } from "../src/backtest.ts";
import { FetchGitHubApi } from "../src/github/client.ts";
import { isMaintainer } from "../src/github/types.ts";
import { DiskCache } from "../src/util/cache.ts";

const DAY = 86_400_000;
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    at: { type: "string", default: new Date(Date.now() - 150 * DAY).toISOString().slice(0, 10) },
    horizon: { type: "string", default: "120" },
    pages: { type: "string", default: "8" },
    dump: { type: "string" },
  },
});
const T = new Date(`${values.at}T00:00:00Z`);
const END = new Date(T.getTime() + Number(values.horizon) * DAY);
const PAGES = Number(values.pages);
const CORE_FIXES = 4;
const STARTER = /help[- _]?wanted|good[- _]first[- _]issue|good first|beginner|starter|newcomer|first[- _]timers?|up[- _]for[- _]grabs|contributions? welcome|\beasy\b|low[- _]hanging|e-easy|d: easy|difficulty: easy/i;

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const api = new FetchGitHubApi({ token, cache: new DiskCache(join(homedir(), ".cache", "gitgoblin", "intel", "api")), cacheTtlMs: 7 * DAY });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (values.dump) writeFileSync(values.dump, "");

/** Pages of issues, newest activity first, until `stop` says the rest are too old. Paced and retried for burst limits. */
async function pagesOf(owner: string, name: string, states: ("OPEN" | "CLOSED")[], stop: (i: BacktestIssue) => boolean): Promise<BacktestIssue[]> {
  const out: BacktestIssue[] = [];
  let after: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await fetchIssueSamples(api, owner, name, { states, first: 50, after });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        await sleep(15_000 * (attempt + 1));
      }
    }
    out.push(...result.issues);
    await sleep(400);
    if (!result.hasNextPage || result.issues.some(stop)) break;
    after = result.endCursor;
  }
  return out;
}

interface Row {
  repo: string;
  number: number;
  accepted: boolean;
  starter: boolean;
  maintainerCommented: boolean;
  score: number | null;
  /** Fixed by an outsider's merged pull request, by association. */
  outsider: boolean;
  /** Also not the reporter and not a frequent closer. */
  strict: boolean;
}

const rows: Row[] = [];
for (const repo of positionals) {
  const [owner, name] = repo.split("/") as [string, string];
  try {
    // Closed after T: their last update is after T too, so page until updates fall before T.
    const closed = await pagesOf(owner, name, ["CLOSED"], (i) => Date.parse(i.updatedAt) < T.getTime());
    const open = await pagesOf(owner, name, ["OPEN"], () => false);
    const population = [...closed, ...open].filter((i) => Date.parse(i.createdAt) < T.getTime() && (!i.closedAt || Date.parse(i.closedAt) > T.getTime()) && !i.author?.isBot);
    const closer = (i: BacktestIssue) => (i.closedAt !== undefined && Date.parse(i.closedAt) <= END.getTime() && i.closedBy?.merged ? i.closedBy : undefined);
    const fixes = new Map<string, number>();
    for (const i of population) {
      const login = closer(i)?.authorLogin;
      if (login) fixes.set(login, (fixes.get(login) ?? 0) + 1);
    }
    const repoRows: Row[] = [];
    for (const issue of population) {
      const then = issueAsOf(issue, T);
      const a = assessIssue(then, T, true, `https://github.com/${owner}/${name}`);
      const accepted = !a.skipReason && (a.kind === "issue" || a.kind === "feature_request");
      const pr = closer(issue);
      const outsider = Boolean(pr && issue.stateReason === "COMPLETED" && !pr.authorIsBot && !isMaintainer(pr.authorAssociation));
      const strict = outsider && pr!.authorLogin !== issue.author?.login && (fixes.get(pr!.authorLogin ?? "") ?? 0) < CORE_FIXES;
      const row: Row = {
        repo, number: issue.number, accepted,
        starter: issue.labels.some((l) => STARTER.test(l)),
        maintainerCommented: [...then.firstComments, ...then.lastComments].some((c) => isMaintainer(c.association)),
        score: accepted ? issueScore(then, a, T) : null,
        outsider, strict,
      };
      repoRows.push(row);
      if (values.dump) {
        const s = accepted ? issueSignals(then, a, T).signals : undefined;
        appendFileSync(values.dump, `${JSON.stringify({
          ...row, kind: a.kind, skipReason: a.skipReason ?? null, endorsed: Boolean(a.endorsed), confirmedLabel: a.confirmedLabel ?? null,
          hasRepro: a.hasRepro, hasTrace: a.hasTrace, easy: a.easy, hard: a.hard, isDocs: a.isDocs, novelty: a.novelty,
          ageDays: Math.round((T.getTime() - Date.parse(issue.createdAt)) / DAY), idleDays: Math.round((T.getTime() - Date.parse(then.updatedAt)) / DAY),
          commentCount: then.commentCount, sampledComments: then.lastComments.length, reactions: issue.reactions, bodyLength: issue.body.trim().length,
          labels: issue.labels, author: issue.author?.login ?? null,
          signals: s ? { value: s.value, feasibility: s.feasibility, confidence: s.confidence, novelty: s.novelty, welcomenessFactor: s.welcomenessFactor } : null,
          closer: pr ? { login: pr.authorLogin ?? null, association: pr.authorAssociation, bot: pr.authorIsBot, fixes: fixes.get(pr.authorLogin ?? "") ?? 0 } : null,
        })}\n`);
      }
    }
    rows.push(...repoRows);
    const acc = repoRows.filter((r) => r.accepted);
    console.error(`${repo}: ${repoRows.length} open at T, ${count(repoRows, "strict")} fixed by outsiders (strict); accepted ${acc.length}, ${count(acc, "strict")}`);
  } catch (error) {
    console.error(`${repo}: skipped (${(error as Error).message.split("\n")[0]!.slice(0, 140)})`);
  }
}

function count(rs: Row[], key: "outsider" | "strict"): number {
  return rs.filter((r) => r[key]).length;
}

function pct(k: number, n: number): string {
  return n ? `${((100 * k) / n).toFixed(1)}%` : "-";
}

console.log(`\nT = ${T.toISOString().slice(0, 10)}, outcome window to ${END.toISOString().slice(0, 10)} (${values.horizon} days), ${positionals.length} repositories, ${new Set(rows.map((r) => r.repo)).size} with issues open at T`);
console.log("\nSelection: share of issues fixed by an outsider's merged pull request");
console.log("group | issues | association | rate | lift | strict | rate | lift");
const groups: [string, (r: Row) => boolean][] = [
  ["all open at T", () => true],
  ["intel accepted", (r) => r.accepted],
  ["intel passed over", (r) => !r.accepted],
  ["starter label", (r) => r.starter],
  ["maintainer commented", (r) => r.maintainerCommented],
  ["intel accepted + starter label", (r) => r.accepted && r.starter],
];
const base = { outsider: count(rows, "outsider") / rows.length, strict: count(rows, "strict") / rows.length };
for (const [label, member] of groups) {
  const g = rows.filter(member);
  const lift = (key: "outsider" | "strict") => (g.length && base[key] ? `${(count(g, key) / g.length / base[key]).toFixed(2)}x` : "-");
  console.log(`${label} | ${g.length} | ${count(g, "outsider")} | ${pct(count(g, "outsider"), g.length)} | ${lift("outsider")} | ${count(g, "strict")} | ${pct(count(g, "strict"), g.length)} | ${lift("strict")}`);
}

// Ranking, within each repository: pairs of accepted issues where one was fixed by an outsider and the other was not.
console.log("\nRanking among accepted issues, within each repository (strict outcome)");
const byRepo = new Map<string, Row[]>();
for (const r of rows) if (r.accepted) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
let concordant = 0, pairs = 0;
const ks = [3, 5, 10];
const hits = new Map(ks.map((k) => [k, { hit: 0, expected: 0, slots: 0 }]));
for (const rs of byRepo.values()) {
  const pos = rs.filter((r) => r.strict), neg = rs.filter((r) => !r.strict);
  for (const p of pos) for (const q of neg) { pairs++; concordant += p.score! > q.score! ? 1 : p.score === q.score ? 0.5 : 0; }
  // Ties broken by issue number, newest first, as a stable stand-in for the report's order.
  const ranked = [...rs].sort((a, b) => b.score! - a.score! || b.number - a.number);
  for (const k of ks) {
    const h = hits.get(k)!, take = Math.min(k, rs.length);
    h.hit += ranked.slice(0, take).filter((r) => r.strict).length;
    h.expected += (take * pos.length) / rs.length;
    h.slots += take;
  }
}
console.log(`pairwise AUC ${pairs ? (concordant / pairs).toFixed(3) : "-"} over ${pairs} pairs in ${[...byRepo.values()].filter((rs) => rs.some((r) => r.strict)).length} repositories with an outsider fix`);
for (const k of ks) {
  const h = hits.get(k)!;
  console.log(`top ${k}: ${h.hit} outsider-fixed of ${h.slots} shown (${pct(h.hit, h.slots)}); random among accepted would give ${h.expected.toFixed(1)}`);
}
console.log(`API requests: ${api.stats.requests}`);
