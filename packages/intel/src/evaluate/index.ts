import type { ContributionOpportunity, RepositoryProfile, ScoreFactor, SkippedFinding } from "../contracts.ts";
import type { Finding } from "../analyzers/types.ts";
import { stableId } from "../util/text.ts";

export const WEIGHTS = { value: 0.35, feasibility: 0.15, welcomeness: 0.25, confidence: 0.15, novelty: 0.1 } as const;

const MAX_EVIDENCE = 12;
/** Keep the report varied: repetitive kinds are capped, issues and fixes are not. */
const KIND_CAPS: Partial<Record<string, number>> = { test_gap: 3, tech_debt: 2, triage: 2, hygiene: 3, stale_pr: 3 };
const MAX_FILES = 10;

export interface EvaluationResult {
  opportunities: ContributionOpportunity[];
  skipped: SkippedFinding[];
}

/** Filter, cluster, score and rank findings into opportunities. */
export function evaluate(findings: Finding[], profile: RepositoryProfile, maxOpportunities: number, kindCaps: Partial<Record<string, number>> = KIND_CAPS): EvaluationResult {
  const skipped: SkippedFinding[] = [];
  const kept: Finding[] = [];
  for (const finding of findings) {
    const reason = rejectionReason(finding, profile);
    if (reason) skipped.push({ kind: finding.kind, title: finding.title, reason });
    else kept.push(finding);
  }

  const clustered = cluster(kept);
  const scored = clustered.map((f) => toOpportunity(f, profile)).sort((a, b) => b.score - a.score);
  const opportunities: ContributionOpportunity[] = [];
  const perKind = new Map<string, number>();
  for (const o of scored) {
    const cap = kindCaps[o.kind];
    const n = perKind.get(o.kind) ?? 0;
    if (cap !== undefined && n >= cap) {
      skipped.push({ kind: o.kind, title: o.title, reason: `more than ${cap} ${o.kind.replace("_", " ")} items; kept the best ${cap} (score ${o.score.toFixed(2)})` });
      continue;
    }
    if (opportunities.length >= maxOpportunities) {
      skipped.push({ kind: o.kind, title: o.title, reason: `ranked below the top ${maxOpportunities} (score ${o.score.toFixed(2)})` });
      continue;
    }
    perKind.set(o.kind, n + 1);
    opportunities.push(o);
  }
  return { opportunities, skipped };
}

const CODE_KINDS = new Set(["test_gap", "deprecation", "tech_debt", "docs_drift", "dependency"]);
const NON_CODE_NATURES = new Set(["awesome_list", "docs", "config", "tutorial", "data", "template"]);

export function rejectionReason(finding: Finding, profile: RepositoryProfile): string | undefined {
  if (profile.archived) return "repository is archived";
  if (profile.welcomeness.level === "closed") return `repository is closed to contributions: ${profile.welcomeness.signals[0]?.signal ?? "closed"}`;
  const novelty = finding.signals.novelty ?? 0.9;
  if (novelty < 0.1) return finding.signals.noveltyReason ?? "someone is already working on it";
  if (NON_CODE_NATURES.has(profile.nature) && CODE_KINDS.has(finding.kind)) return `${finding.kind} does not apply to a ${profile.nature.replace("_", " ")}`;
  if (finding.evidence.length === 0) return "no evidence attached";
  return undefined;
}

/** Merge findings that share a cluster key; evidence and files are combined and capped. */
export function cluster(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.kind}:${f.clusterKey}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const merged: Finding[] = [];
  for (const group of groups.values()) {
    const head = group[0]!;
    if (group.length === 1) {
      merged.push(head);
      continue;
    }
    const evidence = dedupeBy(group.flatMap((g) => g.evidence), (e) => e.id);
    const files = dedupeBy(group.flatMap((g) => g.files), (f) => f);
    const total = evidence.length;
    merged.push({
      ...head,
      summary: total > MAX_EVIDENCE ? `${head.summary} ${total} occurrences in total; ${MAX_EVIDENCE} shown.` : head.summary,
      evidence: evidence.slice(0, MAX_EVIDENCE),
      files: files.slice(0, MAX_FILES),
      effort: group.length >= 8 && head.effort === "trivial" ? "small" : head.effort,
      signals: {
        ...head.signals,
        // Many instances of the same problem are worth a little more, with a soft cap.
        value: Math.min(1, head.signals.value * (1 + Math.min(group.length - 1, 10) * 0.03)),
        confidence: Math.max(...group.map((g) => g.signals.confidence)),
      },
    });
  }
  return merged;
}

export function scoreFactors(finding: Finding, profile: RepositoryProfile): ScoreFactor[] {
  const s = finding.signals;
  const factor = s.welcomenessFactor ?? 1;
  const welcomeness = clamp(profile.welcomeness.score * factor, 0.02, 1);
  const welcomenessReason = [
    `repository is ${profile.welcomeness.level} (${profile.welcomeness.score.toFixed(2)})`,
    s.welcomenessReason ?? (factor !== 1 ? `adjusted x${factor}` : undefined),
  ].filter(Boolean).join("; ");
  return [
    { name: "value", score: clamp(s.value, 0, 1), reason: s.valueReason },
    { name: "feasibility", score: clamp(s.feasibility, 0, 1), reason: s.feasibilityReason },
    { name: "welcomeness", score: welcomeness, reason: welcomenessReason },
    { name: "confidence", score: clamp(s.confidence, 0, 1), reason: s.confidenceReason },
    { name: "novelty", score: clamp(s.novelty ?? 0.9, 0, 1), reason: s.noveltyReason ?? "no sign of in-flight work" },
  ];
}

/** Weighted geometric mean: one near-zero factor sinks the whole score. */
export function aggregate(factors: ScoreFactor[]): number {
  let logSum = 0;
  for (const f of factors) logSum += WEIGHTS[f.name] * Math.log(Math.max(f.score, 0.01));
  return Math.round(Math.exp(logSum) * 1000) / 1000;
}

function toOpportunity(finding: Finding, profile: RepositoryProfile): ContributionOpportunity {
  const factors = scoreFactors(finding, profile);
  const opportunity: ContributionOpportunity = {
    id: stableId("opp", profile.repo.owner, profile.repo.name, finding.kind, finding.clusterKey),
    repo: profile.repo,
    kind: finding.kind,
    title: finding.title,
    summary: finding.summary,
    evidence: finding.evidence,
    factors,
    score: aggregate(factors),
    effort: finding.effort,
    skills: finding.skills,
    files: finding.files,
    approach: finding.approach,
    acceptanceCriteria: finding.acceptanceCriteria,
    etiquette: [...(finding.etiquette ?? []), ...repoEtiquette(profile)],
    risks: finding.risks ?? [],
  };
  if (finding.issue) opportunity.issue = finding.issue;
  return opportunity;
}

/** Etiquette every contribution to this repository should follow. */
export function repoEtiquette(profile: RepositoryProfile): string[] {
  const rules = profile.welcomeness.rules;
  const items: string[] = [];
  if (rules.requiresIssueFirst) items.push(`Open an issue or discussion before the PR; ${rules.contributingPath ?? "the contributing guide"} asks for it.`);
  if (rules.cla) items.push("Sign the CLA when the bot asks.");
  if (rules.dco) items.push("Sign off commits (DCO): git commit -s.");
  if (rules.requiresTests) items.push("Include tests with the change.");
  if (rules.requiresChangelog) items.push("Add a changelog entry.");
  if (rules.pullRequestTemplatePath) items.push(`Fill in the PR template at ${rules.pullRequestTemplatePath}.`);
  if (profile.conventions.commitStyle === "conventional") items.push("Use conventional commit messages (feat:, fix:, docs:).");
  if (profile.welcomeness.level === "selective") items.push("Maintainers merge selectively; keep the change small and ask before expanding scope.");
  return items;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
