import type { Effort, Evidence, RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { CI_RULES, type CiRule, PWN_REQUEST } from "./ci-rules.ts";
import { type Analyzer, type Finding, evidence, textFiles } from "./types.ts";

export interface CiMatch {
  rule: CiRule;
  path: string;
  line: number;
  text: string;
}

/** Match the rule table against every workflow line, skipping comments. */
export function matchCiRules(path: string, text: string, rules: CiRule[] = CI_RULES): CiMatch[] {
  const matches: CiMatch[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const code = raw.replace(/\s#.*$/, "").trim();
    if (!code || code.startsWith("#")) continue;
    const hits = rules.filter((rule) => rule.pattern.test(code));
    // A line that is outright broken does not also need a "deprecated" note.
    const broken = hits.some((r) => r.severity === "broken");
    for (const rule of hits) {
      if (broken && rule.severity === "deprecated") continue;
      matches.push({ rule, path, line: i + 1, text: raw.trim() });
    }
  }
  return matches;
}

/** True when a workflow uses pull_request_target and checks out the PR head. */
export function hasPwnRequest(text: string): { line: number; text: string } | undefined {
  if (!/^[ \t]*(-[ \t]*)?pull_request_target\b|pull_request_target[ \t]*:/m.test(text)) return undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)\s*\}\}/.test(line) || /ref:\s*refs\/pull\/\$\{\{/.test(line)) {
      return { line: i + 1, text: line.trim() };
    }
  }
  return undefined;
}

export const ciRotAnalyzer: Analyzer = {
  name: "ci-rot",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    if (profile.ci.provider !== "github_actions") return [];
    const dependabotActions = await dependabotCoversActions(ctx);
    const findings: Finding[] = [];

    for await (const { path, text } of textFiles(ctx, (p) => p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p), 50)) {
      for (const match of matchCiRules(path, text)) findings.push(toFinding(ctx, match, dependabotActions));
      const pwn = hasPwnRequest(text);
      if (pwn) {
        findings.push({
          kind: "ci_rot",
          clusterKey: PWN_REQUEST.id,
          title: PWN_REQUEST.title,
          summary: PWN_REQUEST.detail,
          evidence: [evidence(ctx, "file", `${path}:${pwn.line}`, { excerpt: pwn.text, note: "PR head checked out under pull_request_target" })],
          files: [path],
          effort: "small",
          skills: ["github-actions", "security"],
          approach: [PWN_REQUEST.fix, "Explain the risk in the PR with a link to the GitHub Security Lab write-up.", "Verify the workflow still produces the same results for a PR from a fork."],
          acceptanceCriteria: ["No workflow checks out pull request code while running with the base repository's token.", "Existing PR checks still run."],
          etiquette: ["Consider reporting privately first if the repository has a SECURITY.md; this is a security weakness."],
          risks: ["Maintainers may have intentionally accepted the risk for a trusted-contributor workflow."],
          signals: {
            value: 0.8, valueReason: "closes a known supply-chain hole (pwn request)",
            feasibility: 0.8, feasibilityReason: "contained workflow change with a documented pattern",
            confidence: 0.85, confidenceReason: "trigger and checkout ref matched in the same workflow; intent not verified",
          },
        });
      }
    }
    return findings;
  },
};

function toFinding(ctx: AnalysisContext, match: CiMatch, dependabotActions: boolean): Finding {
  const { rule } = match;
  const ev: Evidence = evidence(ctx, "file", `${match.path}:${match.line}`, { excerpt: match.text, note: rule.title });
  const broken = rule.severity === "broken";
  const effort: Effort = "trivial";
  const welcomenessFactor = broken ? 1 : dependabotActions ? 0.35 : 0.85;
  return {
    kind: "ci_rot",
    clusterKey: rule.id,
    title: rule.title,
    summary: rule.detail,
    evidence: [ev],
    files: [match.path],
    effort,
    skills: ["github-actions", "yaml"],
    approach: [rule.fix, "Run the workflow on a fork or a draft PR to confirm it goes green.", `Cite ${rule.reference} in the PR description.`],
    acceptanceCriteria: ["The updated workflow completes successfully on the default branch.", "No other job in the workflow regresses."],
    risks: broken ? [] : ["Version bumps alone can look like churn; bundle all workflow fixes into one PR."],
    signals: {
      value: broken ? 0.8 : rule.id === "macos-14-deprecated" ? 0.65 : 0.45,
      valueReason: broken ? "CI is failing or will fail on this step" : "CI still works but is on borrowed time",
      feasibility: 0.95,
      feasibilityReason: "one-line workflow edits with a documented replacement",
      confidence: broken ? 0.95 : 0.9,
      confidenceReason: `matched a documented rule (${rule.reference})`,
      welcomenessFactor,
      welcomenessReason: dependabotActions && !broken ? "Dependabot already updates GitHub Actions here" : broken ? "fixing a broken CI step is rarely refused" : undefined,
    },
  };
}

async function dependabotCoversActions(ctx: AnalysisContext): Promise<boolean> {
  const text = (await ctx.read(".github/dependabot.yml")) ?? (await ctx.read(".github/dependabot.yaml"));
  return Boolean(text && /package-ecosystem:\s*["']?github-actions/.test(text));
}
