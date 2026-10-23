import { RANKING_LABELS, RANKINGS } from "./baselines.ts";
import { type BacktestDataset, type BacktestRow, covered, type Evaluation } from "./discovery-backtest.ts";
import { SWEEP_FILES, subkind } from "./intel-backtest.ts";

export function table(header: string[], rows: (string | number | undefined)[][]): string {
  const cell = (v: string | number | undefined) => (v === undefined ? "n/a" : typeof v === "number" ? fmt(v) : v);
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export function fmt(v: number, digits = 3): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "n/a";
}

export function renderEvaluation(dataset: Pick<BacktestDataset, "asOf" | "windowDays" | "fetchedAt" | "rows">, ev: Evaluation): string {
  const lines: string[] = [];
  lines.push(`## Discovery backtest: contribute ranking against newcomer outcomes`, "");
  lines.push(`As of ${dataset.asOf.slice(0, 10)}, outcomes over the following ${dataset.windowDays} days, fetched ${dataset.fetchedAt.slice(0, 10)}. ${dataset.rows.length} repositories${ev.uncovered ? `, ${ev.uncovered} dropped because the pull request history fetched did not reach back to the as-of date` : ", all included (sensitivity check: rows whose history does not reach back to the as-of date favour popularity)"}.`, "");
  lines.push(
    table(
      ["language", "candidates", "eligible at T", "grade 0", "grade 1", "grade 2", "grade 3"],
      ev.pools.map((p) => [p.language, p.candidates, p.eligible, ...[0, 1, 2, 3].map((g) => p.grades.filter((x) => x === g).length)]),
    ),
    "",
  );
  lines.push(`Macro-averaged over languages (each language is one query). nDCG and precision are at ${ev.k}; precision counts grade 2 or better; AUC separates grade 1+ from grade 0; Spearman is against merged newcomer pull requests. The last column is nDCG@${ev.k} minus gitgoblin's with a 95% bootstrap interval over repositories.`, "");
  lines.push(
    table(
      ["ranking", `nDCG@${ev.k}`, `P@${ev.k}`, "AUC", "Spearman", "delta nDCG vs gitgoblin"],
      RANKINGS.map((r) => {
        const m = ev.overall[r];
        const d = ev.ndcgDelta[r];
        return [RANKING_LABELS[r], m.ndcg, m.precision, m.auc, m.spearman, r === "gitgoblin" ? "" : `${d.estimate >= 0 ? "+" : ""}${fmt(d.estimate)} [${fmt(d.lower)}, ${fmt(d.upper)}]`];
      }),
    ),
    "",
  );
  lines.push(`Newcomer's odds: among the ${ev.oddsPool} eligible repositories with at least three decided newcomer pull requests in the window, how well does each ranking predict the share of them that were merged? This outcome ignores how busy a project is.`, "");
  lines.push(
    table(
      ["ranking", "Spearman with newcomer merge rate", "AUC (merge rate >= 0.5)"],
      RANKINGS.filter((r) => ev.odds[r]).map((r) => {
        const o = ev.odds[r]!;
        return [RANKING_LABELS[r], `${fmt(o.spearman.estimate)} [${fmt(o.spearman.lower)}, ${fmt(o.spearman.upper)}]`, o.auc];
      }),
    ),
    "",
  );
  lines.push(`Per language, nDCG@${ev.k}:`, "");
  const languages = Object.keys(ev.perLanguage);
  lines.push(table(["ranking", ...languages], RANKINGS.map((r) => [RANKING_LABELS[r], ...languages.map((l) => ev.perLanguage[l]![r].ndcg)])), "");
  return lines.join("\n");
}

export function renderTracker(dataset: Pick<BacktestDataset, "asOf" | "rows">): string {
  const lines: string[] = [];
  lines.push(`## Beyond the tracker: the year before ${dataset.asOf.slice(0, 10)}`, "");
  const byLanguage = new Map<string, typeof dataset.rows>();
  for (const row of dataset.rows) byLanguage.set(row.language, [...(byLanguage.get(row.language) ?? []), row]);
  const rowsOut: (string | number)[][] = [];
  const sum = (rows: typeof dataset.rows, pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const line = (label: string, rows: typeof dataset.rows) => {
    const merged = sum(rows, (r) => r.tracker.outsiderMerged);
    const withIssue = sum(rows, (r) => r.tracker.outsiderMergedWithIssue);
    const completed = sum(rows, (r) => r.tracker.completedIssues);
    const byPr = sum(rows, (r) => r.tracker.completedByAnyPr);
    const byOutsider = sum(rows, (r) => r.tracker.completedByOutsiderPr);
    const shares = rows.filter((r) => r.tracker.outsiderMerged >= 5).map((r) => r.tracker.outsiderMergedWithIssue / r.tracker.outsiderMerged).sort((a, b) => a - b);
    const median = shares.length ? shares[Math.floor(shares.length / 2)]! : undefined;
    rowsOut.push([label, rows.length, merged, pct(withIssue, merged), median === undefined ? "n/a" : pct(median, 1), completed, pct(byPr, completed), pct(byOutsider, completed)]);
  };
  for (const [language, rows] of byLanguage) line(language, rows);
  line("all", dataset.rows);
  lines.push(
    table(["language", "repos", "merged outsider PRs", "referencing an issue", "median share per repo (5+ PRs)", "issues closed as completed", "closed by a PR", "closed by an outsider's PR"], rowsOut),
    "",
  );
  return lines.join("\n");
}

export function renderIntel(dataset: { asOf: string; fetchedAt: string; rows: import("./intel-backtest.ts").IntelBacktestRow[] }): string {
  const lines: string[] = [];
  const findings = dataset.rows.flatMap((r) => r.findings.map((f) => ({ ...f, repo: r.id })));
  lines.push(`## Intel backtest: opportunities found at ${dataset.asOf.slice(0, 10)}, checked ${dataset.fetchedAt.slice(0, 10)}`, "");
  lines.push(`${dataset.rows.length} repositories, ${findings.length} file-anchored findings (issue, feature request, stale pull request, triage and run-based CI findings read today's API and were dropped: ${dataset.rows.reduce((s, r) => s + r.liveKindsDropped, 0)}).`, "");
  const kinds = [...new Set(findings.map((f) => f.kind))].sort();
  const SWEEP = SWEEP_FILES;
  const summarize = (label: string, fs: typeof findings): (string | number)[] => {
    const gone = fs.filter((f) => f.status === "excerpt_gone");
    const targeted = gone.filter((f) => f.commit !== undefined && f.commit.files <= SWEEP);
    const removed = fs.filter((f) => f.status === "file_removed");
    const moved = fs.filter((f) => f.status === "moved");
    const outsider = targeted.filter((f) => f.commit?.by === "outsider");
    const maintainer = targeted.filter((f) => f.commit?.by === "maintainer");
    const controlled = fs.filter((f) => f.control !== undefined);
    const controlGone = controlled.filter((f) => f.controlTargeted === true);
    const unverifiable = fs.filter((f) => f.status === "unverifiable");
    return [label, fs.length, pct(targeted.length, fs.length), targeted.length, gone.length - targeted.length, removed.length, moved.length, unverifiable.length, outsider.length, maintainer.length, pct(outsider.length, fs.length), controlled.length ? pct(controlGone.length, controlled.length) : "n/a"];
  };
  lines.push(`"Acted upon" counts excerpts removed by an identified commit touching at most ${SWEEP} files; removals inside larger sweeps or without an attributable commit, deleted files, excerpts that moved to another file, and excerpts that were never verbatim in the file ("unverifiable") are listed but not counted. "Control" is the share of random lines from the same files at T that were removed the same way (an identified commit touching at most ${SWEEP} files): the background churn an acted-upon rate has to beat. A hand-read sample is in the results note.`, "");
  const header = ["kind", "findings", "acted upon", "targeted removal", "in a sweep or unattributed", "file removed", "moved", "unverifiable", "by an outsider", "by a maintainer", "outsider rate", "control"];
  lines.push(table(header, [...kinds.map((k) => summarize(k, findings.filter((f) => f.kind === k))), summarize("all", findings)]), "");
  const subkinds = [...new Set(findings.map((f) => `${f.kind}/${subkind(f.kind, f.title)}`))].sort();
  if (subkinds.some((s) => s.split("/")[0] !== s.split("/")[1])) {
    lines.push(`By sub-kind (from titles):`, "");
    lines.push(table(header, subkinds.map((sk) => summarize(sk, findings.filter((f) => `${f.kind}/${subkind(f.kind, f.title)}` === sk)))), "");
  }
  lines.push(`By rank within each report:`, "");
  lines.push(table(["rank", "findings", "acted upon", "by an outsider", "control"], [
    summarize("top 5", findings.filter((f) => f.rank <= 5)).filter((_, i) => [0, 1, 2, 10, 11].includes(i)),
    summarize("6 to 15", findings.filter((f) => f.rank > 5 && f.rank <= 15)).filter((_, i) => [0, 1, 2, 10, 11].includes(i)),
    summarize("below 15", findings.filter((f) => f.rank > 15)).filter((_, i) => [0, 1, 2, 10, 11].includes(i)),
  ]), "");
  const starter = dataset.rows.map((r) => r.starter);
  const sum = (pick: (s: (typeof starter)[number]) => number) => starter.reduce((s, x) => s + pick(x), 0);
  const openAtT = sum((s) => s.openAtT);
  lines.push(`Baseline: issues carrying a starter label at T in the same repositories.`, "");
  lines.push(table(["starter issues open at T", "resolved by an outsider's PR", "resolved by a maintainer's PR", "closed without a PR", "still open"], [[openAtT, `${sum((s) => s.resolvedByOutsiderPr)} (${pct(sum((s) => s.resolvedByOutsiderPr), openAtT)})`, `${sum((s) => s.resolvedByMaintainerPr)} (${pct(sum((s) => s.resolvedByMaintainerPr), openAtT)})`, `${sum((s) => s.closedWithoutPr)} (${pct(sum((s) => s.closedWithoutPr), openAtT)})`, `${sum((s) => s.stillOpen)} (${pct(sum((s) => s.stillOpen), openAtT)})`]]), "");
  lines.push(`Per repository:`, "");
  lines.push(table(["repository", "commit", "findings", "acted upon", "by an outsider", "starter open at T", "starter resolved by outsiders"], dataset.rows.map((r) => {
    const acted = r.findings.filter((f) => f.status === "excerpt_gone" && f.commit !== undefined && f.commit.files <= SWEEP).length;
    const outsider = r.findings.filter((f) => f.status === "excerpt_gone" && f.commit !== undefined && f.commit.files <= SWEEP && f.commit.by === "outsider").length;
    return [r.id.replace("github.com/", ""), r.sha.slice(0, 8), r.findings.length, acted, outsider, r.starter.openAtT, r.starter.resolvedByOutsiderPr];
  })), "");
  return lines.join("\n");
}

export function renderLearning(results: import("./learn.ts").HeldOutResult[], fit: import("./learn.ts").Fit, minGrade: number): string {
  const lines: string[] = [];
  lines.push(`## Held-out fit: can re-weighting discovery's signals predict grade >= ${minGrade}?`, "");
  lines.push(`Each row is one language scored by a logistic model trained on the other languages. "gitgoblin" is the AUC of the hand-tuned contribute score on that language; "learned" is the held-out model; the rest are single signals on their own.`, "");
  const features = fit.features;
  lines.push(table(["language", "n", "positives", "gitgoblin", "learned", ...features], results.map((r) => [r.group, r.n, r.positives, r.baseline, r.learned, ...features.map((f) => r.single[f])])), "");
  lines.push(`Standardised weights of the model fitted on all languages (sign and size say which signals carry the outcome):`, "");
  lines.push(table(["signal", "weight"], features.map((f, i) => [f, fit.weights[i]!]).sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number))), "");
  return lines.join("\n");
}

/** Where the repositories newcomers succeeded in came from, and how many stars they had. */
export function renderSlices(dataset: { asOf: string; rows: BacktestRow[] }): string {
  const rows = dataset.rows.filter((r) => !r.excluded && covered(r, dataset.asOf));
  const lines: string[] = [];
  lines.push(`## Where the good ones come from`, "");
  lines.push(`Eligible repositories by the star band that found them. "success" is grade 2 or better: at least two newcomer pull requests merged with a merge rate of at least a half.`, "");
  const slices = [...new Set(rows.flatMap((r) => r.slices))].sort();
  const quantile = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : undefined);
  const line = (label: string, rs: BacktestRow[]): (string | number | undefined)[] => {
    const success = rs.filter((r) => r.grade >= 2);
    return [label, rs.length, success.length, pct(success.length, rs.length), quantile(rs.map((r) => r.starsNow), 0.5), quantile(success.map((r) => r.starsNow), 0.5), success.filter((r) => r.starsNow < 500).length];
  };
  lines.push(table(["slice", "repositories", "success", "success rate", "median stars", "median stars of successes", "successes under 500 stars"], [...slices.map((s) => line(s, rows.filter((r) => r.slices.includes(s)))), line("all", rows)]), "");
  const successes = rows.filter((r) => r.grade >= 2);
  const unlabelled = successes.filter((r) => r.starterIssuesAtT === 0);
  lines.push(`${unlabelled.length} of ${successes.length} successes had no open starter-labelled issue at T: a label search would not have shown them.`, "");
  lines.push(`Success rate by stars:`, "");
  const bands: [string, (s: number) => boolean][] = [["under 100", (s) => s < 100], ["100 to 999", (s) => s >= 100 && s < 1000], ["1,000 to 9,999", (s) => s >= 1000 && s < 10_000], ["10,000 and up", (s) => s >= 10_000]];
  lines.push(table(["stars", "repositories", "success", "success rate", "median newcomer PRs merged"], bands.map(([label, test]) => {
    const rs = rows.filter((r) => test(r.starsNow));
    const success = rs.filter((r) => r.grade >= 2);
    return [label, rs.length, success.length, pct(success.length, rs.length), quantile(rs.map((r) => r.outcome.merged), 0.5)];
  })), "");
  return lines.join("\n");
}

export function renderKinds(data: import("./tracker-kinds.ts").KindsDataset): string {
  const lines: string[] = [];
  const kinds = Object.keys(data.byKind) as (keyof typeof data.byKind)[];
  lines.push(`## What merged outsider work looks like (year before ${data.asOf.slice(0, 10)})`, "");
  lines.push(`${data.sampledPullRequests} merged outsider pull requests sampled (up to 8 per repository) across ${data.repositories} repositories, classified by the files they touched. "with issue" means the pull request closes an issue.`, "");
  const total = kinds.reduce((s, k) => s + data.byKind[k].withIssue + data.byKind[k].withoutIssue, 0);
  lines.push(table(["kind", "pull requests", "share", "with issue", "without issue", "share without issue"], kinds.map((k) => {
    const c = data.byKind[k];
    const n = c.withIssue + c.withoutIssue;
    return [k, n, pct(n, total), c.withIssue, c.withoutIssue, pct(c.withoutIssue, n)];
  })), "");
  lines.push(`By language, share of sampled pull requests:`, "");
  const languages = Object.keys(data.byLanguage);
  lines.push(table(["kind", ...languages], kinds.map((k) => [k, ...languages.map((l) => {
    const counts = data.byLanguage[l]!;
    const n = kinds.reduce((s, kk) => s + counts[kk].withIssue + counts[kk].withoutIssue, 0);
    return pct(counts[k].withIssue + counts[k].withoutIssue, n);
  })])), "");
  return lines.join("\n");
}

export function renderIssueGrading(data: import("./intel-backtest.ts").IssueGradingDataset): string {
  const issues = data.rows.flatMap((r) => r.issues);
  const lines: string[] = [];
  lines.push(`## Accepted issue opportunities: what happened to them (checked ${data.fetchedAt.slice(0, 10)})`, "");
  lines.push(`${issues.length} issue-backed opportunities accepted across ${data.rows.length} repositories at analysis time. "Fixed before the run" means the closing pull request had already merged when intel accepted the issue, which intel's "already fixed?" check is meant to catch; "flagged" counts how many of those it did catch.`, "");
  const fates: import("./intel-backtest.ts").IssueFate[] = ["completed_by_pr", "completed_without_pr", "not_planned", "duplicate", "closed_unknown", "open_with_merged_pr", "open"];
  lines.push(table(["fate", "issues", "share"], fates.map((f) => [f.replaceAll("_", " "), issues.filter((i) => i.fate === f).length, pct(issues.filter((i) => i.fate === f).length, issues.length)])), "");
  const byPr = issues.filter((i) => i.fate === "completed_by_pr");
  const before = byPr.filter((i) => i.fixedBeforeRun);
  lines.push(table(["completed by a PR", "by an outsider", "by a maintainer", "fixed before the run", "of which flagged by intel"], [[byPr.length, byPr.filter((i) => i.fixedBy === "outsider").length, byPr.filter((i) => i.fixedBy === "maintainer").length, before.length, before.filter((i) => i.flaggedAlreadyFixed).length]]), "");
  const drift = issues.filter((i) => i.fate === "open_with_merged_pr");
  lines.push(`Drift at analysis time: ${drift.length} accepted issues were open with a merged closing pull request (${drift.filter((i) => i.fixedBeforeRun).length} merged before the run); intel flagged ${drift.filter((i) => i.flaggedAlreadyFixed).length} of them.`, "");
  const bands: [string, (i: import("./intel-backtest.ts").IssueOutcome) => boolean][] = [["top 5", (i) => i.rank <= 5], ["6 to 15", (i) => i.rank > 5 && i.rank <= 15], ["below 15", (i) => i.rank > 15]];
  lines.push(table(["rank", "issues", "completed", "by an outsider"], bands.map(([label, test]) => {
    const rs = issues.filter(test);
    const done = rs.filter((i) => i.fate === "completed_by_pr" || i.fate === "completed_without_pr");
    return [label, rs.length, pct(done.length, rs.length), pct(rs.filter((i) => i.fixedBy === "outsider").length, rs.length)];
  })), "");
  return lines.join("\n");
}
