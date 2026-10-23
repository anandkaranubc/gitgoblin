import type { RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { type PrSample, isMaintainer, unquoted } from "../github/types.ts";
import { daysAgo } from "../util/time.ts";
import { truncate } from "../util/text.ts";
import { type Analyzer, type Finding, evidence } from "./types.ts";

// Requests for work only; approval phrases (LGTM, looks good) mean the ball is with the maintainers.
const WANTS_UPDATE = /\b(needs? (a )?rebase|rebase|merge conflicts?|conflicts? (with|need)|please (update|address|fix|rebase|resolve|add|change)|any updates?|still (interested|working|planning)|ping|waiting (on|for) (you|author|the author|changes|an update)|could you (update|rebase|address|add|fix|change|also)|can you (update|rebase|address|add|fix|change|also)|would you (mind|be able)|mind (adding|updating|rebasing|fixing)|ready to merge once)\b/i;
const STALE_LABEL = /needs[- _]rebase|stale|waiting[- _]for[- _]author|needs[- _]work|changes[- _]requested|inactive|abandoned/i;

export interface StaleAssessment {
  eligible: boolean;
  reason: string;
  approved: boolean;
  maintainerAsked: string | undefined;
  idleDays: number;
  authorIdleDays: number | undefined;
}

export function assessStalePr(pr: PrSample, now: Date): StaleAssessment {
  const idleDays = daysAgo(pr.updatedAt, now);
  const approved = pr.reviews.some((r) => r.state === "APPROVED" && isMaintainer(r.association));
  const maintainerComments = pr.lastComments.filter((c) => c.author && !c.author.isBot && isMaintainer(c.association) && c.author.login !== pr.author?.login);
  const asked = maintainerComments.find((c) => c.body && WANTS_UPDATE.test(unquoted(c.body)));
  const askedText = asked?.body ? unquoted(asked.body).trim() : undefined;
  const changesRequested = pr.reviews.some((r) => r.state === "CHANGES_REQUESTED" && isMaintainer(r.association));
  const authorLast = [...pr.lastComments].reverse().find((c) => c.author?.login === pr.author?.login);
  const authorIdleDays = authorLast ? daysAgo(authorLast.createdAt, now) : undefined;
  // Interest alone is not enough: an approved, mergeable PR is waiting on maintainers, not on a contributor.
  const needsWork = asked !== undefined || changesRequested || pr.labels.some((l) => STALE_LABEL.test(l)) || (pr.mergeable === "CONFLICTING" && (approved || maintainerComments.length > 0));
  const maintainerInterest = needsWork;
  const base = { approved, maintainerAsked: askedText, idleDays, authorIdleDays };
  if (pr.isDraft) return { ...base, eligible: false, reason: "draft" };
  if (pr.author?.isBot) return { ...base, eligible: false, reason: "bot PR" };
  if (idleDays < 60) return { ...base, eligible: false, reason: `active ${Math.round(idleDays)} days ago` };
  if (!maintainerInterest) return { ...base, eligible: false, reason: approved ? "approved and mergeable; waiting on maintainers, nothing for an outsider to do" : "no sign maintainers wanted it or asked for changes" };
  if (authorIdleDays !== undefined && authorIdleDays < 60) return { ...base, eligible: false, reason: "author still responding" };
  return { ...base, eligible: true, reason: pr.mergeable === "CONFLICTING" && approved ? "approved but now conflicting" : changesRequested ? "changes requested and author went quiet" : asked ? "maintainers asked for an update and got none" : "flagged as needing work" };
}

export const stalePrsAnalyzer: Analyzer = {
  name: "stale-prs",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    const samples = ctx.samples;
    if (!samples) return [];
    const findings: Finding[] = [];
    const open = samples.openPrs;
    for (const pr of open) {
      const a = assessStalePr(pr, ctx.now);
      if (!a.eligible) continue;
      const size = pr.additions + pr.deletions;
      const superseded = open.find((o) => o.number !== pr.number && o.closingIssues.some((n) => pr.closingIssues.includes(n)) && daysAgo(o.updatedAt, ctx.now) < 60);
      const ev = [evidence(ctx, "pull_request", pr.url, { excerpt: pr.title, note: `${a.reason}; idle ${Math.round(a.idleDays)} days; ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}; mergeable: ${pr.mergeable.toLowerCase()}` })];
      if (a.maintainerAsked) ev.push(evidence(ctx, "pull_request", `${pr.url}#issuecomment`, { excerpt: truncate(a.maintainerAsked, 180), note: "maintainer comment" }));
      findings.push({
        kind: "stale_pr",
        clusterKey: `pr:${pr.number}`,
        title: `Revive PR #${pr.number}: ${truncate(pr.title, 80)}`,
        summary: `The pull request was ${a.reason}. The author has not responded for ${a.authorIdleDays !== undefined ? Math.round(a.authorIdleDays) : Math.round(a.idleDays)}+ days, so the work is stuck one rebase away from landing.`,
        evidence: ev,
        files: [],
        effort: size < 100 ? "small" : size < 600 ? "medium" : "large",
        skills: profile.languages.slice(0, 1).map((l) => l.name.toLowerCase()),
        approach: [
          `Ask in #${pr.number} whether the author minds you carrying it forward; wait a few days.`,
          "Rebase their branch onto the default branch, resolve conflicts, and address the review comments.",
          "Open a new PR that keeps the original author as a co-author (Co-authored-by) and links the old one.",
        ],
        acceptanceCriteria: ["The rebased change passes CI and addresses every outstanding review comment.", "Original authorship is credited."],
        etiquette: ["Never open a competing PR without asking first; credit the original author."],
        risks: [...(superseded ? [`PR #${superseded.number} may already supersede it.`] : []), "Maintainers may have lost interest; confirm before rebasing."],
        signals: {
          value: Math.min(0.85, 0.5 + (a.approved ? 0.15 : 0) + (pr.closingIssues.length ? 0.1 : 0)) * (a.idleDays > 365 ? 0.7 : 1),
          valueReason: `${a.approved ? "approved work" : "wanted work"} that only needs a rebase${pr.closingIssues.length ? `; closes #${pr.closingIssues.join(", #")}` : ""}${a.idleDays > 365 ? "; idle over a year, interest may have faded" : ""}`,
          feasibility: size < 300 ? 0.75 : 0.55,
          feasibilityReason: `the code exists (+${pr.additions}/-${pr.deletions}); conflicts and review notes remain`,
          confidence: 0.8,
          confidenceReason: "review states and comment ages come from the API; intent is inferred from wording",
          novelty: superseded ? 0.3 : 0.85,
          noveltyReason: superseded ? `PR #${superseded.number} targets the same issue` : "no newer PR targets the same change",
          welcomenessFactor: 0.9,
        },
      });
      if (findings.length >= 5) break;
    }
    return findings;
  },
};
