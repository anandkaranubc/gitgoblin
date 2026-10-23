import type { AnalysisReport, ContributionOpportunity } from "../contracts.ts";

/** Human-readable report. */
export function renderMarkdown(report: AnalysisReport): string {
  const p = report.profile;
  const out: string[] = [];
  const title = `${p.repo.owner}/${p.repo.name}`;
  out.push(`# ${title}`, "");
  if (p.description) out.push(`_${p.description}_`, "");
  out.push(`**Nature:** ${p.nature.replace("_", " ")} (${p.natureReason})  `);
  out.push(`**Languages:** ${p.languages.slice(0, 4).map((l) => `${l.name} ${Math.round(l.share * 100)}%`).join(", ") || "n/a"}  `);
  out.push(`**Stars:** ${p.stars} · **Forks:** ${p.forks} · **License:** ${p.license ?? "none detected"}${p.archived ? " · **ARCHIVED**" : ""}  `);
  const a = p.activity;
  out.push(`**Activity:** ${a.commits90d} commits / ${a.authors90d} authors in 90 days; bus factor ${a.busFactor}; last push ${a.lastPushAt?.slice(0, 10) ?? "unknown"}  `);
  out.push(`**Responsiveness:** ${fmtHours(a.medianIssueResponseHours)} to first reply on issues, ${fmtHours(a.medianPrResponseHours)} on PRs (unanswered items count as still waiting); ${a.externalPrMergeRate !== undefined ? `${Math.round(a.externalPrMergeRate * 100)}% of outside PRs merged (n=${a.sampleSizes.externalPullRequests})` : "outside PR merge rate unknown"}  `);
  out.push(`**Welcomeness:** ${p.welcomeness.level} (${p.welcomeness.score.toFixed(2)})`);
  for (const s of [...p.welcomeness.signals].sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight)).slice(0, 5)) out.push(`- ${s.weight >= 0 ? "+" : "−"} ${s.signal} — ${s.evidence.note ?? s.evidence.locator}`);
  const rules = p.welcomeness.rules;
  const ruleBits = [rules.requiresIssueFirst && "issue first", rules.cla && "CLA", rules.dco && "DCO", rules.requiresTests && "tests required", rules.requiresChangelog && "changelog required", rules.dependencyBot && "dependency bot"].filter(Boolean);
  if (ruleBits.length || rules.rejectedChanges.length) {
    out.push("", `**Rules:** ${ruleBits.join(", ") || "none stated"}`);
    for (const r of rules.rejectedChanges.slice(0, 3)) out.push(`- rejects: "${r}"`);
  }
  if (p.ecosystems.length) {
    out.push("", "**How to work on it:**");
    for (const e of p.ecosystems) {
      const cmds = Object.entries(e.commands).map(([k, v]) => `${k}: \`${v}\``).join(" · ");
      out.push(`- ${e.name}${e.packageManager ? ` (${e.packageManager})` : ""}${e.runtime ? `, ${e.runtime}` : ""}: ${cmds || "no commands detected"}`);
    }
  }
  if (p.conventions.recentCommitSubjects.length) out.push("", `**Conventions:** ${p.conventions.commitStyle} commits${p.conventions.branchNaming ? `, branches ${p.conventions.branchNaming}` : ""}${p.conventions.typicalPrSizeLines ? `, typical PR ${p.conventions.typicalPrSizeLines} lines` : ""}${p.conventions.testFramework ? `, tests with ${p.conventions.testFramework}` : ""}`);
  for (const n of p.notes) out.push(`> ${n}`);

  out.push("", `## Opportunities (${report.opportunities.length})`, "");
  if (report.opportunities.length === 0) out.push("_None passed the filters._");
  report.opportunities.forEach((o, i) => out.push(...renderOpportunity(o, i + 1)));

  if (report.skipped.length) {
    out.push("", `## Skipped (${report.skipped.length})`, "");
    const byReason = new Map<string, number>();
    for (const s of report.skipped) byReason.set(s.reason.replace(/\(score [\d.]+\)/, "").trim(), (byReason.get(s.reason.replace(/\(score [\d.]+\)/, "").trim()) ?? 0) + 1);
    for (const [reason, n] of [...byReason.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)) out.push(`- ${n}× ${reason}`);
  }
  const b = report.budget;
  out.push("", `---`, `_${(b.totalMs / 1000).toFixed(1)}s total, clone ${(b.cloneMs / 1000).toFixed(1)}s, ${b.apiRequests} API requests, ${b.httpChecks} HTTP checks${b.truncated ? "; analysis was truncated" : ""}._`);
  for (const n of b.notes) out.push(`_${n}_  `);
  return out.join("\n");
}

function renderOpportunity(o: ContributionOpportunity, rank: number): string[] {
  const lines: string[] = [];
  lines.push(`### ${rank}. ${o.title}`, "");
  lines.push(`\`${o.kind}\` · score **${o.score.toFixed(2)}** · effort ${o.effort} · skills: ${o.skills.join(", ") || "n/a"}`, "");
  lines.push(o.summary, "");
  lines.push(`Factors: ${o.factors.map((f) => `${f.name} ${f.score.toFixed(2)}`).join(" · ")}  `);
  for (const f of o.factors) if (f.score < 0.5 || f.name === "welcomeness") lines.push(`- ${f.name}: ${f.reason}`);
  lines.push("", "Evidence:");
  for (const e of o.evidence.slice(0, 6)) lines.push(`- ${e.locator}${e.excerpt ? ` — \`${e.excerpt.replace(/`/g, "'")}\`` : ""}${e.note ? ` (${e.note})` : ""}`);
  if (o.evidence.length > 6) lines.push(`- …and ${o.evidence.length - 6} more`);
  if (o.files.length) lines.push("", `Files: ${o.files.slice(0, 5).map((f) => `\`${f}\``).join(", ")}`);
  lines.push("", "Approach:");
  o.approach.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (o.etiquette.length) lines.push("", `Etiquette: ${o.etiquette.join(" ")}`);
  if (o.risks.length) lines.push("", `Risks: ${o.risks.join(" ")}`);
  lines.push("");
  return lines;
}

function fmtHours(h: number | undefined): string {
  if (h === undefined) return "unknown time";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
