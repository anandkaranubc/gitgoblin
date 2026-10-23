import { z } from "zod";

import type { RepositoryProfile } from "../contracts.ts";
import type { IssueSample } from "../github/types.ts";
import { isMaintainer } from "../github/types.ts";
import type { DiskCache } from "../util/cache.ts";
import { daysAgo } from "../util/time.ts";
import { issueBody } from "../analyzers/issue-text.ts";
import { stripControl, truncate } from "../util/text.ts";
import type { LlmClient } from "./client.ts";

export const IssueReview = z.object({
  number: z.number().int(),
  /** What kind of thing the issue is, judged from its text. */
  verdict: z.enum(["defect", "feature", "docs", "question", "discussion", "unclear"]),
  /** Specific enough to reproduce or locate, and fixable without a maintainer decision. */
  actionable: z.boolean(),
  /** Only from comments marked [maintainer]. */
  maintainerStance: z.enum(["endorsed", "neutral", "pushback", "unknown"]),
  /** One sentence restating the problem in plain words. */
  problem: z.string(),
  /** Verbatim phrase from the issue (at most 15 words) that best supports the verdict. */
  quote: z.string(),
  // No length limits in the schema: the SDK checks them only after the call and throws, losing the whole batch.
  // Lengths are capped after parsing instead.
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type IssueReview = z.infer<typeof IssueReview>;

const Batch = z.object({ reviews: z.array(IssueReview) });

export const PROMPT_VERSION = "3";
export const BATCH_SIZE = 15;
const CACHE_TTL_MS = 14 * 24 * 3_600_000;

export const SYSTEM_PROMPT = `You are an experienced open-source maintainer triaging GitHub issues for an outside contributor who is deciding what to work on. You see only the text provided; judge from it alone.

For each issue, decide:
- verdict: "defect" when the author reports behaviour that is wrong, broken, crashing, inconsistent or regressed; "feature" when they ask for new behaviour or an option; "docs" when the problem is in documentation, examples or type annotations rather than behaviour; "question" when they ask how to do something or why something works a certain way; "discussion" for design debates, roadmaps and proposals that need maintainers to decide; "unclear" when the text does not support a confident call.
- actionable: true only when the problem is specific enough to reproduce or locate from the text, and fixing it would not require a maintainer decision about design, scope or policy.
- maintainerStance: from comments marked [maintainer] only. "endorsed" when a maintainer confirms the problem or invites a fix; "pushback" when they say it is intended, out of scope, a duplicate or not reproducible; "neutral" when they comment without taking a position; "unknown" when no maintainer commented.
- problem: one plain sentence restating what is wrong or wanted.
- quote: a verbatim phrase of at most 15 words copied from the issue or a comment that best supports your verdict. Never paraphrase inside the quote.
- rationale: at most 25 words on why you chose the verdict and actionability.
- confidence: 0 to 1.

Never invent files, behaviour or maintainer opinions that are not in the text. Prefer "unclear" over guessing.`;

export interface ReviewInput {
  llm: LlmClient;
  profile: Pick<RepositoryProfile, "repo" | "nature" | "languages" | "description">;
  issues: IssueSample[];
  now: Date;
  cache?: DiskCache | undefined;
  /** Called once per failed batch. Reviewing continues with the next batch unless credentials are missing or the API rate-limits. */
  onError?: ((error: unknown) => void) | undefined;
}

/** Review issues in batches, using the cache for issues already judged at this updatedAt. */
export async function reviewIssues(input: ReviewInput): Promise<Map<number, IssueReview>> {
  const { llm, profile, issues, now, cache } = input;
  const results = new Map<number, IssueReview>();
  const pending: IssueSample[] = [];
  for (const issue of issues) {
    const cached = cache ? await cache.get<IssueReview>(cacheKey(llm.model, profile, issue), CACHE_TTL_MS) : undefined;
    if (cached) results.set(issue.number, cached);
    else pending.push(issue);
  }
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      const parsed = await llm.parse(SYSTEM_PROMPT, renderBatch(profile, batch, now), Batch);
      if (!parsed) continue;
      for (const review of parsed.reviews) {
        const issue = batch.find((b) => b.number === review.number);
        if (!issue) continue; // the model may not invent issue numbers
        // Model text is data: no control or format characters reach the report. (Done here, not in the
        // schema: the SDK's structured output cannot represent zod transforms.)
        review.problem = truncate(stripControl(review.problem), 600);
        review.quote = truncate(stripControl(review.quote), 300);
        review.rationale = truncate(stripControl(review.rationale), 400);
        // A stance needs a real maintainer comment among those the model was shown; text claiming to be one does not count.
        if (!promptComments(issue).some((c) => c.role === "maintainer")) review.maintainerStance = "unknown";
        if (!quoteOccurs(review.quote, issue)) review.quote = "";
        results.set(review.number, review);
        await cache?.set(cacheKey(llm.model, profile, issue), review);
      }
    } catch (error) {
      input.onError?.(error);
      // Missing credentials or a rate limit will fail every batch; anything else (one malformed answer) is local.
      const status = (error as { status?: unknown }).status;
      if (status === 401 || status === 403 || status === 429 || /ANTHROPIC_API_KEY|credentials|apiKey/i.test(String((error as Error).message))) break;
    }
  }
  return results;
}

function cacheKey(model: string, profile: ReviewInput["profile"], issue: IssueSample): string {
  return `llm-issue-review:v${PROMPT_VERSION}:${model}:${profile.repo.owner}/${profile.repo.name}#${issue.number}@${issue.updatedAt}`;
}

export function renderBatch(profile: ReviewInput["profile"], issues: IssueSample[], now: Date): string {
  const head = [
    `Repository: ${profile.repo.owner}/${profile.repo.name} (${profile.nature.replace("_", " ")}; ${profile.languages.slice(0, 3).map((l) => l.name).join(", ") || "language unknown"})`,
    ...(profile.description ? [`Description: ${userText(profile.description, 300)}`] : []),
    `Review the following ${issues.length} issue${issues.length === 1 ? "" : "s"}. Return one review per issue, keyed by its number.`,
  ].join("\n");
  return `${head}\n\n${issues.map((issue) => renderIssue(issue, now)).join("\n\n")}`;
}

/** Spellings of a role marker an issue author might use to pass as a maintainer: [maintainer], [ maintainer ], fullwidth brackets. */
const ROLE_MARKER = /[[［]\s{0,3}(maintainer|author|user)\s{0,3}[\]］]/gi;
/** Zero-width characters that could split a marker so it survives replacement (`[main<ZWJ>tainer]`). Removed from model input only. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/** Repository-authored text as model input: no control or bidi characters, and nothing imitating the prompt's role markers or headings. */
function userText(text: string, max: number): string {
  return truncate(stripControl(text).replace(ZERO_WIDTH, "").replace(ROLE_MARKER, "($1)").replace(/^#{1,6}[ \t]{0,3}(Issue[ \t]{0,3}#|Title:|Body:)/gim, "$1"), max);
}

/** The comments the model is shown, with the role it is told: the last four from people, labelled by real association. */
export function promptComments(issue: IssueSample): { role: "author" | "maintainer" | "user"; createdAt: string; body: string }[] {
  return issue.lastComments
    .slice(-4)
    .filter((c) => c.body && !c.author?.isBot)
    .map((c) => ({ role: c.author?.login === issue.author?.login ? "author" as const : isMaintainer(c.association) ? "maintainer" as const : "user" as const, createdAt: c.createdAt, body: c.body! }));
}

export function renderIssue(issue: IssueSample, now: Date): string {
  const lines = [
    `### Issue #${issue.number} (opened ${Math.round(daysAgo(issue.createdAt, now))} days ago, ${issue.commentCount} comments, ${issue.reactions} reactions, labels: ${issue.labels.map((l) => userText(l, 40)).join(", ") || "none"})`,
    `Title: ${userText(issue.title, 200)}`,
    // The template-free body (linear-time, comments and checklists gone) is what a reader would look at.
    `Body: ${userText(issueBody(issue.body), 1500) || "(empty)"}`,
  ];
  for (const c of promptComments(issue)) lines.push(`[${c.role}] ${c.createdAt.slice(0, 10)}: ${userText(c.body, 300)}`);
  return lines.join("\n");
}

/** The model's quote must be a real phrase of the issue or its comments. Whitespace and case may differ. */
export function quoteOccurs(quote: string, issue: IssueSample): boolean {
  const norm = (t: string) => stripControl(t).toLowerCase().replace(/[\s`*_>"'“”‘’]+/g, " ").trim();
  const q = norm(quote);
  if (q.length < 3) return false;
  return norm([issue.title, issue.body, ...issue.lastComments.map((c) => c.body ?? "")].join("\n")).includes(q);
}
