import type { DiscoveryResult, Goal, Reason, SignalName } from "@gitgoblin/core";
import { SIGNAL_DESCRIPTIONS, SIGNAL_NAMES } from "@gitgoblin/core";
import type { AnalysisReport, ContributionOpportunity, RepositoryProfile } from "@gitgoblin/intel";

/*
 * Renderings written for a model: short, one block per item, the strongest reasons only.
 * Each text renderer has a `compact*` twin that produces the matching structuredContent.
 */

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Items shown per list in a briefing; repository-controlled lists can be arbitrarily long. */
const LIST_CAP = 12;

/** The first `max` items, then how many more there are. */
export function listSome(items: string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** Up to three reasons that helped and the one that hurt most. */
export function strongestReasons(reasons: Reason[], positive = 3, negative = 1): Reason[] {
  const sorted = [...reasons].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return [...sorted.filter((r) => r.weight > 0).slice(0, positive), ...sorted.filter((r) => r.weight < 0).slice(0, negative)];
}

export type CompactResult = {
  repository: string;
  url: string;
  description?: string | undefined;
  stars: number;
  language?: string | undefined;
  license?: string | undefined;
  score: number;
  reasons: { signal: string; weight: number; detail: string }[];
  starter_issues?: { number: number; title: string; url: string }[] | undefined;
}

export function compactResult(result: DiscoveryResult): CompactResult {
  const { repo } = result;
  const issues = result.issues?.slice(0, 3).map((i) => ({ number: i.number, title: i.title, url: i.url }));
  return {
    repository: `${repo.owner}/${repo.name}`,
    url: repo.url,
    description: repo.description ? truncate(repo.description, 160) : undefined,
    stars: repo.stars,
    language: repo.language,
    license: repo.license,
    score: Number(result.score.toFixed(2)),
    reasons: strongestReasons(result.reasons).map((r) => ({ signal: r.signal, weight: Number(r.weight.toFixed(3)), detail: r.detail })),
    starter_issues: issues && issues.length > 0 ? issues : undefined,
  };
}

function headline(result: DiscoveryResult): string {
  const { repo } = result;
  const meta = [`★ ${compactNumber(repo.stars)}`, repo.language, repo.license].filter(Boolean).join(" · ");
  return `${repo.owner}/${repo.name}  ${meta}  score ${result.score.toFixed(2)}`;
}

export function formatDiscovery(results: DiscoveryResult[], goal: Goal): string {
  if (results.length === 0) return `No repositories matched for goal "${goal}". Try fewer filters, another language, or another goal.`;
  const blocks = results.map((result, index) => {
    const lines = [`${index + 1}. ${headline(result)}`];
    if (result.repo.description) lines.push(`   ${truncate(result.repo.description, 160)}`);
    lines.push(`   ${result.repo.url}`);
    for (const reason of strongestReasons(result.reasons)) lines.push(`   ${reason.weight > 0 ? "+" : "−"} ${reason.detail}`);
    for (const issue of (result.issues ?? []).slice(0, 3)) lines.push(`   starter issue #${issue.number}: ${truncate(issue.title, 90)}  ${issue.url}`);
    return lines.join("\n");
  });
  return [`${results.length} repositories for goal "${goal}", best first. Scores compare within this goal only.`, "", blocks.join("\n\n")].join("\n");
}

export type CompactExplanation = {
  repository: string;
  url: string;
  goal: Goal;
  score: number;
  signals: { signal: string; value?: number | undefined; weight?: number | undefined; detail: string }[];
  starter_issues?: { number: number; title: string; url: string }[] | undefined;
}

export function compactExplanation(result: DiscoveryResult): CompactExplanation {
  const byName = new Map<string, Reason>(result.reasons.filter((r) => r.signal !== "filter" && r.signal !== "jitter").map((r) => [r.signal, r]));
  return {
    repository: `${result.repo.owner}/${result.repo.name}`,
    url: result.repo.url,
    goal: result.goal,
    score: Number(result.score.toFixed(2)),
    signals: SIGNAL_NAMES.map((name) => {
      const value = result.signals[name as SignalName];
      const reason = byName.get(name);
      return {
        signal: name,
        value: value === undefined ? undefined : Number(value.toFixed(2)),
        weight: reason ? Number(reason.weight.toFixed(3)) : undefined,
        detail: reason?.detail ?? SIGNAL_DESCRIPTIONS[name as SignalName],
      };
    }),
    starter_issues: result.issues?.map((i) => ({ number: i.number, title: i.title, url: i.url })),
  };
}

export function formatExplanation(result: DiscoveryResult): string {
  const lines = [headline(result), result.repo.url, `goal: ${result.goal}`, ""];
  for (const s of compactExplanation(result).signals) {
    const value = s.value === undefined ? "unknown" : s.value.toFixed(2);
    const weight = s.weight === undefined ? "" : ` (${s.weight >= 0 ? "+" : "−"}${Math.abs(s.weight).toFixed(2)} for this goal)`;
    lines.push(`${s.signal}: ${value}${weight}  ${s.detail}`);
  }
  const extras = result.reasons.filter((r) => r.signal === "filter" || r.signal === "jitter");
  if (extras.length > 0) {
    lines.push("");
    for (const reason of extras) lines.push(`${reason.weight >= 0 ? "+" : "−"} ${reason.detail}`);
  }
  if (result.issues?.length) {
    lines.push("", "starter issues:");
    for (const issue of result.issues) lines.push(`  #${issue.number} ${truncate(issue.title, 90)}  ${issue.url}`);
  }
  lines.push("", "A signal shown as unknown could not be measured and did not count against the score.");
  return lines.join("\n");
}

function hours(h: number | undefined): string {
  if (h === undefined) return "unknown";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function profileLines(p: RepositoryProfile): string[] {
  const a = p.activity;
  const w = p.welcomeness;
  const rules = w.rules;
  const ruleBits = [
    rules.requiresIssueFirst && "open an issue before a PR",
    rules.cla && "CLA",
    rules.dco && "DCO sign-off",
    rules.requiresTests && "tests required",
    rules.requiresChangelog && "changelog entry required",
    rules.pullRequestTemplate && "PR template",
    rules.dependencyBot && "a bot handles dependency updates",
  ].filter((x): x is string => typeof x === "string");
  const lines = [
    `${p.repo.owner}/${p.repo.name}  ${[`★ ${compactNumber(p.stars)}`, p.languages[0]?.name, p.license ?? "no license detected"].filter(Boolean).join(" · ")}${p.archived ? " · ARCHIVED" : ""}`,
    `https://${p.repo.host}/${p.repo.owner}/${p.repo.name}`,
  ];
  if (p.description) lines.push(truncate(p.description, 200));
  lines.push(
    `nature: ${p.nature.replace("_", " ")} (${p.natureReason})`,
    `activity: ${a.commits90d} commits by ${a.authors90d} authors in 90 days; bus factor ${a.busFactor}; last push ${a.lastPushAt?.slice(0, 10) ?? "unknown"}; ${a.openIssues} open issues, ${a.openPullRequests} open PRs`,
    `responsiveness: first reply in ${hours(a.medianIssueResponseHours)} on issues and ${hours(a.medianPrResponseHours)} on PRs; ${a.externalPrMergeRate === undefined ? "outside PR merge rate unknown" : `${Math.round(a.externalPrMergeRate * 100)}% of outside PRs merged (n=${a.sampleSizes.externalPullRequests})`}`,
    `welcomeness: ${w.level} (${w.score.toFixed(2)})`,
  );
  for (const s of [...w.signals].sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight)).slice(0, 4)) lines.push(`  ${s.weight >= 0 ? "+" : "−"} ${s.signal}: ${s.evidence.note ?? s.evidence.locator}`);
  if (ruleBits.length > 0) lines.push(`rules: ${ruleBits.join(", ")}`);
  for (const r of rules.rejectedChanges.slice(0, 3)) lines.push(`  maintainers do not want: "${truncate(r, 140)}"`);
  for (const e of p.ecosystems) {
    const cmds = Object.entries(e.commands).map(([k, v]) => `${k}: ${v}`).join(" · ");
    lines.push(`${e.name}${e.packageManager ? ` (${e.packageManager})` : ""}${e.runtime ? `, ${e.runtime}` : ""}: ${cmds || "no commands detected"}`);
  }
  const c = p.conventions;
  const conventionBits = [
    c.commitStyle !== "unknown" && `${c.commitStyle} commits`,
    c.branchNaming && `branches ${c.branchNaming}`,
    c.typicalPrSizeLines && `typical PR ${c.typicalPrSizeLines} lines`,
    c.testFramework && `tests with ${c.testFramework}`,
    c.linter && `lint with ${c.linter}`,
    c.formatter && `format with ${c.formatter}`,
  ].filter((x): x is string => typeof x === "string");
  if (conventionBits.length > 0) lines.push(`conventions: ${conventionBits.join(", ")}`);
  if (p.instructionFiles.length > 0) lines.push(`agent instruction files: ${listSome(p.instructionFiles, 10)}`);
  for (const n of p.notes.slice(0, 3)) lines.push(`note: ${n}`);
  return lines;
}

function opportunityLine(o: ContributionOpportunity, rank: number): string[] {
  const first = o.evidence[0];
  const lines = [
    `${rank}. [${o.id}] ${o.kind}: ${truncate(o.title, 110)}`,
    `   score ${o.score.toFixed(2)} · effort ${o.effort}${o.skills.length ? ` · skills: ${o.skills.join(", ")}` : ""}${o.issue ? ` · issue #${o.issue.number}` : ""}`,
    `   ${truncate(o.summary, 240)}`,
  ];
  if (first) lines.push(`   evidence: ${first.locator}${o.evidence.length > 1 ? ` (+${o.evidence.length - 1} more)` : ""}`);
  return lines;
}

export type CompactReport = {
  repository: string;
  url: string;
  analyzed_at: string;
  head_sha: string;
  nature: string;
  welcomeness: { level: string; score: number };
  activity: { commits_90d: number; authors_90d: number; bus_factor: number; last_push_at?: string | undefined };
  commands: Record<string, string>;
  rules: { issue_first: boolean; cla: boolean; dco: boolean; tests_required: boolean; changelog_required: boolean; rejected_changes: string[] };
  opportunities: {
    id: string;
    kind: string;
    title: string;
    score: number;
    effort: string;
    skills: string[];
    issue_number?: number | undefined;
    summary: string;
    evidence: string[];
  }[];
  skipped: number;
  notes: string[];
}

export function compactReport(report: AnalysisReport, max: number): CompactReport {
  const p = report.profile;
  const commands: Record<string, string> = {};
  for (const e of p.ecosystems) for (const [k, v] of Object.entries(e.commands)) if (v && !commands[k]) commands[k] = v;
  const rules = p.welcomeness.rules;
  return {
    repository: `${p.repo.owner}/${p.repo.name}`,
    url: `https://${p.repo.host}/${p.repo.owner}/${p.repo.name}`,
    analyzed_at: p.analyzedAt,
    head_sha: p.headSha,
    nature: p.nature,
    welcomeness: { level: p.welcomeness.level, score: Number(p.welcomeness.score.toFixed(2)) },
    activity: { commits_90d: p.activity.commits90d, authors_90d: p.activity.authors90d, bus_factor: p.activity.busFactor, last_push_at: p.activity.lastPushAt },
    commands,
    rules: {
      issue_first: rules.requiresIssueFirst,
      cla: rules.cla,
      dco: rules.dco,
      tests_required: rules.requiresTests,
      changelog_required: rules.requiresChangelog,
      rejected_changes: rules.rejectedChanges.slice(0, 10),
    },
    opportunities: report.opportunities.slice(0, max).map((o) => ({
      id: o.id,
      kind: o.kind,
      title: o.title,
      score: Number(o.score.toFixed(2)),
      effort: o.effort,
      skills: o.skills,
      issue_number: o.issue?.number,
      summary: truncate(o.summary, 240),
      evidence: o.evidence.slice(0, 3).map((e) => e.locator),
    })),
    skipped: report.skipped.length,
    notes: report.budget.notes.slice(0, 10),
  };
}

export function formatReport(report: AnalysisReport, max: number): string {
  const lines = profileLines(report.profile);
  const shown = report.opportunities.slice(0, max);
  lines.push("", `Opportunities (${shown.length} of ${report.opportunities.length}${report.skipped.length ? `, ${report.skipped.length} findings skipped` : ""}), best first:`);
  if (shown.length === 0) lines.push("  none passed the filters");
  shown.forEach((o, i) => lines.push("", ...opportunityLine(o, i + 1)));
  lines.push("", "Call get_opportunity with an id for the evidence, approach, acceptance criteria and etiquette of one item.");
  if (report.budget.truncated || report.budget.notes.length) {
    lines.push("");
    if (report.budget.truncated) lines.push("note: analysis was cut short to stay within limits");
    for (const n of report.budget.notes.slice(0, 4)) lines.push(`note: ${truncate(n, 200)}`);
  }
  return lines.join("\n");
}

export function formatOpportunity(report: AnalysisReport, o: ContributionOpportunity): string {
  const p = report.profile;
  const lines = [
    `${o.kind}: ${o.title}`,
    `${p.repo.owner}/${p.repo.name} · score ${o.score.toFixed(2)} · effort ${o.effort}${o.skills.length ? ` · skills: ${o.skills.join(", ")}` : ""}`,
    "",
    o.summary,
  ];
  if (o.issue) {
    lines.push("", `issue #${o.issue.number}: ${o.issue.title}  ${o.issue.url}`);
    if (o.issue.labels.length) lines.push(`  labels: ${o.issue.labels.join(", ")}`);
    if (o.issue.assignees.length) lines.push(`  assignees: ${o.issue.assignees.join(", ")}`);
    if (o.issue.inFlight) lines.push("  WARNING: someone appears to be working on this already");
  }
  lines.push("", "Why it scored this way:");
  for (const f of o.factors) lines.push(`  ${f.name} ${f.score.toFixed(2)}: ${f.reason}`);
  lines.push("", "Evidence:");
  for (const e of o.evidence.slice(0, 8)) lines.push(`  ${e.locator}${e.excerpt ? ` — "${truncate(e.excerpt, 200)}"` : ""}${e.note ? ` (${e.note})` : ""}`);
  if (o.evidence.length > 8) lines.push(`  …and ${o.evidence.length - 8} more`);
  if (o.files.length) lines.push("", `Files to read first: ${o.files.slice(0, 8).join(", ")}`);
  if (o.approach.length) {
    lines.push("", "Approach:");
    o.approach.slice(0, LIST_CAP).forEach((step, i) => lines.push(`  ${i + 1}. ${truncate(step, 300)}`));
  }
  if (o.acceptanceCriteria.length) {
    lines.push("", "Acceptance criteria:");
    for (const c of o.acceptanceCriteria.slice(0, LIST_CAP)) lines.push(`  - ${truncate(c, 300)}`);
  }
  if (o.etiquette.length) {
    lines.push("", "Etiquette for this project:");
    for (const e of o.etiquette.slice(0, LIST_CAP)) lines.push(`  - ${truncate(e, 300)}`);
  }
  if (o.risks.length) {
    lines.push("", "Risks:");
    for (const r of o.risks.slice(0, LIST_CAP)) lines.push(`  - ${truncate(r, 300)}`);
  }
  lines.push("", "How to work on the project:", `  clone: git clone https://${p.repo.host}/${p.repo.owner}/${p.repo.name}.git  (default branch ${p.defaultBranch}, analyzed at ${p.headSha.slice(0, 10)})`);
  for (const e of p.ecosystems) {
    const cmds = Object.entries(e.commands).map(([k, v]) => `${k}: ${v}`).join(" · ");
    if (cmds) lines.push(`  ${e.name}${e.runtime ? ` (${e.runtime})` : ""}: ${cmds}`);
  }
  const c = p.conventions;
  const conv = [c.commitStyle !== "unknown" && `${c.commitStyle} commits`, c.branchNaming && `branches ${c.branchNaming}`, c.typicalPrSizeLines && `typical PR ${c.typicalPrSizeLines} lines`].filter((x): x is string => typeof x === "string");
  if (conv.length) lines.push(`  conventions: ${conv.join(", ")}`);
  if (c.recentCommitSubjects.length) lines.push(`  recent commit subjects: ${c.recentCommitSubjects.slice(0, 3).map((s) => `"${truncate(s, 70)}"`).join(", ")}`);
  const rules = p.welcomeness.rules;
  const ruleBits = [
    rules.contributingPath && `read ${rules.contributingPath}`,
    rules.requiresIssueFirst && "open or find an issue before a PR",
    rules.cla && "sign the CLA",
    rules.dco && "sign off commits (DCO)",
    rules.requiresTests && "include tests",
    rules.requiresChangelog && "add a changelog entry",
    rules.pullRequestTemplatePath && `fill in ${rules.pullRequestTemplatePath}`,
  ].filter((x): x is string => typeof x === "string");
  if (ruleBits.length) lines.push(`  rules: ${ruleBits.join("; ")}`);
  for (const r of rules.rejectedChanges.slice(0, 3)) lines.push(`  maintainers do not want: "${truncate(r, 140)}"`);
  lines.push(
    "",
    "Before acting: check the issue for new comments or linked PRs, follow the project's contributing guide, disclose AI assistance in the pull request description, and let the person decide whether anything gets published.",
    `With the gitgoblin command line installed, \`gitgoblin contribute ${p.repo.host === "github.com" ? "" : `${p.repo.host}/`}${p.repo.owner}/${p.repo.name} --opportunity ${o.id}\` drafts this change with a person approving each step.`,
  );
  return lines.join("\n");
}
