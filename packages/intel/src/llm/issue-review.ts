import { z } from "zod";

import type { RepositoryProfile } from "../contracts.ts";
import type { IssueSample } from "../github/types.ts";
import { isMaintainer } from "../github/types.ts";
import type { DiskCache } from "../util/cache.ts";
import { daysAgo } from "../util/time.ts";
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
  problem: z.string().max(600),
  /** Verbatim phrase from the issue (at most 15 words) that best supports the verdict. */
  quote: z.string().max(300),
  rationale: z.string().max(400),
  confidence: z.number().min(0).max(1),
});
export type IssueReview = z.infer<typeof IssueReview>;

const Batch = z.object({ reviews: z.array(IssueReview) });

export const PROMPT_VERSION = "2";
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
  /** Called once per failed batch; reviewing continues with the next batch. */
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
        review.problem = stripControl(review.problem);
        review.quote = stripControl(review.quote);
        review.rationale = stripControl(review.rationale);
        // A stance needs a real maintainer comment; text in the body claiming to be one does not count.
        if (!issue.lastComments.some((c) => isMaintainer(c.association))) review.maintainerStance = "unknown";
        if (!quoteOccurs(review.quote, issue)) review.quote = "";
        results.set(review.number, review);
        await cache?.set(cacheKey(llm.model, profile, issue), review);
      }
    } catch (error) {
      input.onError?.(error);
      break;
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
    profile.description ? `Description: ${profile.description}` : "",
    `Review the following ${issues.length} issue${issues.length === 1 ? "" : "s"}. Return one review per issue, keyed by its number.`,
    "",
  ].filter((l) => l !== "").join("\n");
  return head + issues.map((issue) => renderIssue(issue, now)).join("\n\n");
}

/** Repository-authored text as model input: no control or bidi characters, and no "[maintainer]" or "### Issue" imitating the structure of the prompt. */
function userText(text: string, max: number): string {
  return truncate(stripControl(text).replace(/\[(maintainer|author|user)\]/gi, "($1)").replace(/^#{1,6}\s*(Issue\s*#|Title:|Body:)/gim, "$1"), max);
}

export function renderIssue(issue: IssueSample, now: Date): string {
  const lines = [
    `### Issue #${issue.number} (opened ${Math.round(daysAgo(issue.createdAt, now))} days ago, ${issue.commentCount} comments, ${issue.reactions} reactions, labels: ${issue.labels.map((l) => userText(l, 40)).join(", ") || "none"})`,
    `Title: ${userText(issue.title, 200)}`,
    `Body: ${userText(issue.body.replace(/<!--[\s\S]*?-->/g, " "), 1500) || "(empty)"}`,
  ];
  for (const c of issue.lastComments.slice(-4)) {
    if (!c.body || c.author?.isBot) continue;
    const who = c.author?.login === issue.author?.login ? "author" : isMaintainer(c.association) ? "maintainer" : "user";
    lines.push(`[${who}] ${c.createdAt.slice(0, 10)}: ${userText(c.body, 300)}`);
  }
  return lines.join("\n");
}

/** The model's quote must be a real phrase of the issue or its comments. Whitespace and case may differ. */
export function quoteOccurs(quote: string, issue: IssueSample): boolean {
  const norm = (t: string) => stripControl(t).toLowerCase().replace(/[\s`*_>"'“”‘’]+/g, " ").trim();
  const q = norm(quote);
  if (q.length < 3) return false;
  return norm([issue.title, issue.body, ...issue.lastComments.map((c) => c.body ?? "")].join("\n")).includes(q);
}
