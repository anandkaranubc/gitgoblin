import type { AnalysisReport, ContributionOpportunity } from "../contracts.ts";
import { inline } from "../util/text.ts";

/** Externally sourced text can shape the report (headings, links, code) if written raw; every such field is flattened to one escaped line. */
const t = (text: string, max = 400): string => inline(text, max);
const code = (text: string): string => `\`${inline(text, 200)}\``;

/** Human-readable report. */
export function renderMarkdown(report: AnalysisReport): string {
  const p = report.profile;
  const out: string[] = [];
  const title = `${p.repo.owner}/${p.repo.name}`;
  out.push(`# ${title}`, "");
  if (p.description) out.push(`_${t(p.description, 300)}_`, "");
  out.push(`**Nature:** ${p.nature.replace("_", " ")} (${t(p.natureReason)})  `);
  out.push(`**Languages:** ${p.languages.slice(0, 4).map((l) => `${l.name} ${Math.round(l.share * 100)}%`).join(", ") || "n/a"}  `);
  out.push(`**Stars:** ${p.stars} · **Forks:** ${p.forks} · **License:** ${p.license ?? "none detected"}${p.archived ? " · **ARCHIVED**" : ""}  `);
  const a = p.activity;
  out.push(`**Activity:** ${a.commits90d} commits / ${a.authors90d} authors in 90 days; bus factor ${a.busFactor}; last push ${a.lastPushAt?.slice(0, 10) ?? "unknown"}  `);
  out.push(`**Responsiveness:** ${fmtHours(a.medianIssueResponseHours)} to first reply on issues, ${fmtHours(a.medianPrResponseHours)} on PRs (unanswered items count as still waiting); ${a.externalPrMergeRate !== undefined ? `${Math.round(a.externalPrMergeRate * 100)}% of outside PRs merged (n=${a.sampleSizes.externalPullRequests})` : "outside PR merge rate unknown"}  `);
  out.push(`**Welcomeness:** ${p.welcomeness.level} (${p.welcomeness.score.toFixed(2)})`);
  for (const s of [...p.welcomeness.signals].sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight)).slice(0, 5)) out.push(`- ${s.weight >= 0 ? "+" : "−"} ${t(s.signal)} — ${t(s.evidence.note ?? s.evidence.locator)}`);
  const rules = p.welcomeness.rules;
  const ruleBits = [rules.requiresIssueFirst && "issue first", rules.cla && "CLA", rules.dco && "DCO", rules.requiresTests && "tests required", rules.requiresChangelog && "changelog required", rules.dependencyBot && "dependency bot"].filter(Boolean);
  if (ruleBits.length || rules.rejectedChanges.length) {
    out.push("", `**Rules:** ${ruleBits.join(", ") || "none stated"}`);
    for (const r of rules.rejectedChanges.slice(0, 3)) out.push(`- rejects: "${t(r, 200)}"`);
  }
  if (p.ecosystems.length) {
    out.push("", "**How to work on it:**");
    for (const e of p.ecosystems) {
      const cmds = Object.entries(e.commands).filter((kv): kv is [string, string] => typeof kv[1] === "string").map(([k, v]) => `${k}: ${code(v)}`).join(" · ");
      out.push(`- ${e.name}${e.packageManager ? ` (${t(e.packageManager, 40)})` : ""}${e.runtime ? `, ${t(e.runtime, 60)}` : ""}: ${cmds || "no commands detected"}`);
    }
  }
  const central = p.structure.centralFiles ?? [];
  if (central.length) out.push("", `**Central modules:** ${central.slice(0, 6).map((c) => `${code(c.path)} (${c.importedBy})`).join(", ")}`);
  if (p.conventions.recentCommitSubjects.length) out.push("", `**Conventions:** ${p.conventions.commitStyle} commits${p.conventions.branchNaming ? `, branches ${t(p.conventions.branchNaming, 60)}` : ""}${p.conventions.typicalPrSizeLines ? `, typical PR ${p.conventions.typicalPrSizeLines} lines` : ""}${p.conventions.testFramework ? `, tests with ${t(p.conventions.testFramework, 40)}` : ""}`);
  for (const n of p.notes) out.push(`> ${t(n)}`);

  out.push("", `## Opportunities (${report.opportunities.length})`, "");
  if (report.opportunities.length === 0) {
    const reviewed = report.budget.notes.find((n) => n.startsWith("issues reviewed"));
    out.push(`_Nothing qualified.${reviewed ? ` ${reviewed[0]!.toUpperCase()}${reviewed.slice(1)}.` : ""} Code and docs analyzers found no evidence-backed problems in this checkout._`);
  }
  report.opportunities.forEach((o, i) => out.push(...renderOpportunity(o, i + 1)));

  if (report.skipped.length) {
    out.push("", `## Skipped (${report.skipped.length})`, "");
    const byReason = new Map<string, number>();
    for (const s of report.skipped) byReason.set(s.reason.replace(/\(score [\d.]+\)/, "").trim(), (byReason.get(s.reason.replace(/\(score [\d.]+\)/, "").trim()) ?? 0) + 1);
    for (const [reason, n] of [...byReason.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)) out.push(`- ${n}× ${t(reason)}`);
  }
  const b = report.budget;
  out.push("", `---`, `_${(b.totalMs / 1000).toFixed(1)}s total, clone ${(b.cloneMs / 1000).toFixed(1)}s, ${b.apiRequests} API requests, ${b.httpChecks} HTTP checks${b.truncated ? "; analysis was truncated" : ""}._`);
  for (const n of b.notes) out.push(`_${t(n, 600)}_  `);
  return out.join("\n");
}

function renderOpportunity(o: ContributionOpportunity, rank: number): string[] {
  const lines: string[] = [];
  lines.push(`### ${rank}. ${t(o.title, 200)}`, "");
  lines.push(`\`${o.kind}\` · score **${o.score.toFixed(2)}** · effort ${o.effort} · skills: ${o.skills.map((s) => t(s, 40)).join(", ") || "n/a"} · id \`${o.id}\``, "");
  lines.push(t(o.summary, 600), "");
  lines.push(`Factors: ${o.factors.map((f) => `${f.name} ${f.score.toFixed(2)}`).join(" · ")}  `);
  for (const f of o.factors) if (f.score < 0.5 || f.name === "welcomeness") lines.push(`- ${f.name}: ${t(f.reason)}`);
  lines.push("", "Evidence:");
  for (const e of o.evidence.slice(0, 6)) lines.push(`- ${t(e.locator, 300)}${e.excerpt ? ` — ${code(e.excerpt)}` : ""}${e.note ? ` (${t(e.note)})` : ""}`);
  if (o.evidence.length > 6) lines.push(`- …and ${o.evidence.length - 6} more`);
  if (o.files.length) lines.push("", `Files: ${o.files.slice(0, 5).map(code).join(", ")}`);
  lines.push("", "Approach:");
  o.approach.forEach((s, i) => lines.push(`${i + 1}. ${t(s, 600)}`));
  if (o.etiquette.length) lines.push("", `Etiquette: ${o.etiquette.map((x) => t(x, 600)).join(" ")}`);
  if (o.risks.length) lines.push("", `Risks: ${o.risks.map((x) => t(x, 600)).join(" ")}`);
  lines.push("");
  return lines;
}

function fmtHours(h: number | undefined): string {
  if (h === undefined) return "unknown time";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
