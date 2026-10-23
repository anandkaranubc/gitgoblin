import type { IssueRef, RepositoryProfile } from "../contracts.ts";
import type { AnalysisContext } from "../context.ts";
import { type CommentSample, type IssueSample, isMaintainer, unquoted } from "../github/types.ts";
import { daysAgo } from "../util/time.ts";
import { truncate } from "../util/text.ts";

import { type Analyzer, type Finding, type FindingSignals, evidence } from "./types.ts";

const BUG_LABEL = /\b(bug|defect|regression|crash|broken|error)\b/i;
const CONFIRMED_LABEL = /confirmed|accepted|triaged|ready|approved|good[- _]first|help[- _]wanted|up[- _]for[- _]grabs|contributions? welcome|\beasy\b|beginner|starter|low[- _]hanging|e-easy|hacktoberfest/i;
const EASY_LABEL = /good[- _]first|\beasy\b|beginner|starter|low[- _]hanging|e-easy|trivial/i;
const HARD_LABEL = /\bhard\b|complex|difficult|needs[- _]design|rfc|architecture|epic|large/i;
const FEATURE_LABEL = /enhancement|feature|improvement|proposal|idea|request/i;
const DOCS_LABEL = /^docs?$|documentation/i;
/** Defect language in titles and bodies, including CamelCase exception names. */
const BUG_WORDS = /\b(bug|crash(es|ed|ing)?|broken|breaks?|fail(s|ed|ing|ure)?|error|exception|regression|incorrect(ly)?|wrong(ly)?|unexpected(ly)?|doesn'?t work|does not work|not work(ing)?|can'?t|cannot|unable|not able|raises?|throws?|hangs?|hanging|leaks?|overflow|unreachable|ignored|inconsistent|traceback|segfault|panics?|deadlock|race condition|stuck|infinite loop|corrupt(ed|s)?|lost|swallow(s|ed)?|silently|unstable|flaky|non-?idempotent|idempotency|regression|mis(handles?|parses?|aligned|placed)|(doesn'?t|does not|didn'?t|won'?t|isn'?t|not) (return|respond|render|load|start|run|match|apply|update|save|send|receive|handle|support|honou?r|respect|recogni[sz]e|detect|trigger|fire|close|open|parse|accept|allow|display|show|refresh|resolve|compile|build|install|work))\b/i;
const EXCEPTION_NAME = /\b[A-Z]\w+(Error|Exception|Warning)\b/;
const BUG_TEXT = { test: (t: string) => BUG_WORDS.test(t) || EXCEPTION_NAME.test(t) };
const FEATURE_TITLE = /^(\[?\s*(feature( request)?|enhancement|proposal|propuesta|proposition|idea|suggestion|rfc)\s*\]?\s*[:\-]?|feat(ure)?:|proposal:|suggestion:|request:|add(ing)?\b|support\b|allow\b|option to|ability to|expose\b|implement\b|provide\b|introduce\b|would be (nice|great|useful)|consider\b|please add|make \w+|(a |an )?(flag|option|setting|way|hook|api) (to|for)\b|restore\b|bring back|re-?add|initiative|roadmap|\w+ should (support|consider|allow|have|use|be able|respect|honou?r))/i;
const DOCS_TEXT = /\b(docs?|documentation|readme|docstrings?|typo|tutorial|example in the docs)\b/i;
/** Words that make a title read as a statement about behaviour rather than a bare noun phrase. */
const TITLE_VERB = /\b(is|are|was|were|be|been|does|do|did|has|have|had|not|no|never|can'?t|cannot|won'?t|doesn'?t|don'?t|isn'?t|aren'?t|should|shouldn'?t|fails?|failed|failing|returns?|throws?|crash\w*|breaks?|broken|hangs?|freez\w+|leaks?|ignores?|ignored|missing|wrong|incorrect\w*|unexpected\w*|inconsistent|regress\w+|segfault|panic\w*|error|exception|slow|stuck|lost|causes?|caused|prevents?|produces?|shows?|gets?|loses?|stops?|triggers?|results? in|when|after|since|while|if|only|always|sometimes|intermittent\w*|randomly|silently|still|again|instead|vs\.?|but|than|adds?|removes?|inserts?|drops?|changes?|converts?|moves?|formats?|prints?|outputs?|reports?|treats?|handles?|parses?|renders?|generates?|emits?|writes?|reads?|loads?|sends?|receives?|uses?|requires?|expects?|allows?|accepts?|rejects?|skips?|keeps?|leaves?|puts?|sets?|makes?|takes?|becomes?|appears?|disappears?|happens?|works?|runs?|starts?|ends?|exits?|opens?|closes?|blocks?|duplicates?|splits?|merges?|wraps?|respects?|follows?|matches?|differs?|depends?|overrides?|replaces?|truncates?|escapes?|strips?|swallows?|resolves?|detects?|warns?|hits?|exceeds?|needs?|wants?|cannot|unable)\b/i;

/** "multiline PDF search" or "Color input fields using FZF scheme colors": a noun phrase, so a wish rather than a report. */
export function looksLikeRequestTitle(title: string): boolean {
  const clean = title.replace(/^\[[^\]]*\]\s*/, "").replace(/`[^`]*`/g, "x").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 9) return false;
  if (BUG_TEXT.test(clean) || TITLE_VERB.test(clean) || /\?/.test(clean)) return false;
  return true;
}
const NEGATIVE_LABEL = /question|discuss(ion)?|won'?t[- _]?fix|invalid|duplicate|blocked|on[- _]hold|stale|waiting|upstream|meta|tracking|roadmap|security|needs[- _](decision|design|discussion)|not[- _]planned|propose[- _]close|close[- _]candidate|core[- _]team|maintainers?[- _]only|internal|team[- _]only/i;
/** Labels maintainers use to say a fix is already underway. */
const IN_FLIGHT_LABEL = /to[- _]?merge|in[- _]progress|has[- _]pr|pr[- _](ready|open|pending)|fix[- _]pending|\bwip\b|work[- _]in[- _]progress|being[- _]worked/i;
const TRIAGE_LABEL = /needs?[- _](info|more[- _]info|repro\w*|triage|confirmation)|unconfirmed|untriaged/i;
const QUESTION_TITLE = /^\[?\s*(question|query|help|support|q|discussion|rfc)\s*\]?\s*[:\-]?\s|^(how (do|can|to|should|does|would|could)|is it possible|is there a way|why (does|is|do|are|can'?t)|what (is|are|does)|can i|could i|should i|does .* support|any way to|possible to|i need help|need help|help (with|needed|wanted:)|use \w+ as\b|using \w+ (with|as)\b|i can'?t|i cannot|i('m| am) (getting|having|unable|trying|facing|stuck)|(my|our) (app|code|project|build|program) (is|isn'?t|doesn'?t|won'?t|crashes|fails))\b|\?\s*$/i;
const QUESTION_BODY = /^(hi|hello|hey)?[,!\s]*(how (do|can|to|should|would|could) (i|we|you|one)|is it possible|is there a way|can (i|we|someone)|could (i|we|someone)|i('m| am) (trying|wondering|looking)|i want to|i would like to (be able|know)|what('s| is) the (best|right|recommended) way)\b/i;

const ENDORSE = /\b(prs?|pull requests?|patch(es)?|contributions?) (are |would be |very |most )?welcome|happy to (accept|review|merge|take)|would (gladly )?(accept|take|merge|welcome|review)|feel free to (open|submit|send|work)|go ahead|sounds (good|reasonable)|good idea|makes sense|i can reproduce|can repro|reproduced|confirmed|agreed?|we should|should be fixed|needs? (a )?fix|accepting (a )?pr|open to (a )?pr|anyone (want|willing|interested)|up for grabs|help wanted|marking (this )?as (help wanted|good first)/i;
const REJECT = /\b(not a bug|not planned|won'?t fix|wontfix|out of scope|by design|as intended|working as (intended|expected|designed)|intended behaviou?r|can'?t reproduce|cannot reproduce|unable to reproduce|not able to reproduce|closing (this|as)|duplicate of|need(s)? more (info|information|details)|please provide|user error|not supported|move this to|moving this to|belongs (in|to) (the )?\S+ (repo|repository|tracker)|wrong repo(sitory)?|should be (filed|reported|opened) (in|at|against|on)|please (report|file|open) (this|it) (in|at|on|against)|transferr?(ing|ed) (this|the issue))\b/i;
const CLAIM = /\b(?:i('|’)?ll|i will|i'?d like to|i would like to|can i|could i|may i|let me|i am going to|i'?m going to|i can|happy to|i want to|allow me to|i'?m|i am)\s+(?:also\s+|gladly\s+|try to\s+|start(?:ing)? to\s+)?(?:take|work|working|look|looking|pick|tackle|handle|fix|fixing|implement|implementing|submit|open|send|give|try)\b[^.!?\n]{0,40}?\b(?:this|it|that|one|a pr|a pull request|a fix|a patch|the issue|the bug|on it|on this|a shot|a go)\b|\bassign (?:this |it )?to me\b|\bplease assign\b|\bi'?m on it\b|\bworking on (?:a |the )?(?:fix|pr|patch|this)\b/i;
const MAINTAINER_HANDLING = /\b(i('|’)?ll|i will|i'?m|i am|we'?ll|we are|we're|i have a|i've got a|working on (a |the )?(fix|patch|pr)|fix (is )?(incoming|coming|in progress)|pr (incoming|coming)|fixed in|should be fixed (by|in) #|on my list)\b/i;
const REPRO = /steps to reproduce|reproduc|expected (behaviou?r|result|output)|actual (behaviou?r|result|output)|minimal (example|repro|reproduction)|how to reproduce|to reproduce/i;
const TRACE = /traceback \(most recent|^\s+at .+\(.+:\d+:\d+\)|panic:|goroutine \d+|exception in thread|segmentation fault|^\w*(Error|Exception)(:| )/im;
const PATH_TOKEN = /(?<![\w/])((?:[\w.-]+\/)+[\w.-]+\.(?:py|js|jsx|ts|tsx|go|rs|rb|java|kt|php|cs|c|h|cpp|md|rst|yml|yaml|toml|json|html|css|scss|vue|svelte)|[\w-]+\.(?:py|go|rs|rb|java|md))\b/g;

/** GitHub `/pull/`, GitLab `/-/merge_requests/` and Gitea `/pulls/` URLs under this repository. */
export function isSameRepoPr(url: string, repoUrl: string): boolean {
  return url.startsWith(`${repoUrl}/pull/`) || url.startsWith(`${repoUrl}/pulls/`) || url.startsWith(`${repoUrl}/-/merge_requests/`);
}

export interface IssueAssessment {
  kind: "issue" | "feature_request" | "triage";
  skipReason?: string | undefined;
  novelty: number;
  noveltyReason: string;
  endorsed: CommentSample | undefined;
  rejected: CommentSample | undefined;
  hasRepro: boolean;
  hasTrace: boolean;
  easy: boolean;
  hard: boolean;
  confirmedLabel: string | undefined;
  claim: { comment: CommentSample; daysAgo: number } | undefined;
  isDocs: boolean;
}

export function assessIssue(issue: IssueSample, now: Date, repoResponsive: boolean, repoUrl?: string): IssueAssessment {
  const labels = issue.labels;
  // Cross-references can come from other repositories; only this repository's PRs mean in-flight work.
  const linkedPrs = repoUrl ? issue.linkedPrs.filter((p) => isSameRepoPr(p.url, repoUrl)) : issue.linkedPrs;
  const text = `${issue.title}\n${issue.body}`;
  const maintainerComments = issue.lastComments.filter((c) => c.author && !c.author.isBot && isMaintainer(c.association));
  const endorsed = maintainerComments.find((c) => c.body && ENDORSE.test(unquoted(c.body)) && !REJECT.test(unquoted(c.body)));
  const rejected = [...maintainerComments].reverse().find((c) => c.body && REJECT.test(unquoted(c.body)));
  const confirmedLabel = labels.find((l) => CONFIRMED_LABEL.test(l));
  const easy = labels.some((l) => EASY_LABEL.test(l));
  const hard = labels.some((l) => HARD_LABEL.test(l));
  // A bare noun-phrase title with no defect language reads as a wish; it needs endorsement like any feature.
  const requestTitle = looksLikeRequestTitle(issue.title) && !TRACE.test(issue.body);
  const isFeature = labels.some((l) => FEATURE_LABEL.test(l)) || FEATURE_TITLE.test(issue.title) || requestTitle;
  const bugLabel = labels.some((l) => BUG_LABEL.test(l));
  // Body-only bug words are too loose in support-heavy trackers; require defect language in the title, a trace, or repro steps plus defect words.
  // An explicit feature label or title outranks incidental defect words ("Enhancement: include the file name in parse error messages").
  const isBug = bugLabel || (!isFeature && (TRACE.test(issue.body) || BUG_TEXT.test(issue.title) || (REPRO.test(issue.body) && BUG_TEXT.test(issue.body))));
  const isDocs = labels.some((l) => DOCS_LABEL.test(l)) || (DOCS_TEXT.test(issue.title) && !isFeature);
  const hasRepro = REPRO.test(text) || /```/.test(issue.body);
  const hasTrace = TRACE.test(issue.body);
  const age = daysAgo(issue.createdAt, now);
  const idle = daysAgo(issue.updatedAt, now);
  const nonAuthorComments = issue.lastComments.filter((c) => c.author && !c.author.isBot && c.author.login !== issue.author?.login);

  const base = { endorsed, rejected, hasRepro, hasTrace, easy, hard, confirmedLabel, isDocs, claim: undefined as IssueAssessment["claim"] };
  const skip = (reason: string): IssueAssessment => ({ kind: "issue", skipReason: reason, novelty: 0.9, noveltyReason: "", ...base });

  if (issue.locked) return skip("issue is locked");
  if (issue.author?.isBot) return skip("opened by a bot");
  if (labels.some((l) => NEGATIVE_LABEL.test(l) && !TRIAGE_LABEL.test(l))) return skip(`labelled ${labels.find((l) => NEGATIVE_LABEL.test(l))}`);
  if (/\bdup(licate)?s?\b(?! (detection|check|key|entries|values|files|lines|headers|chunks|names|items|records|elements|ids))/i.test(issue.title) && /#\d+|\bof\b/i.test(issue.title)) return skip("title marks it as a duplicate");
  if (rejected && !endorsed) return skip(`a maintainer pushed back: "${truncate(rejected.body ?? "", 100)}"`);
  // Issue templates apply "bug" to everything; a label only carries weight when a maintainer also confirmed or the title says something.
  const titleWords = issue.title.trim().split(/\s+/).filter(Boolean).length;
  const templateLabelOnly = labels.some((l) => BUG_LABEL.test(l)) && !confirmedLabel && !endorsed && (titleWords < 3 || /^(error|bug|help|issue|problem|crash|question|not working|doesn'?t work)$/i.test(issue.title.trim()));
  if (templateLabelOnly) return skip("bug label looks template-applied; the title gives nothing to act on");
  const looksLikeQuestion = QUESTION_TITLE.test(issue.title) || (QUESTION_BODY.test(issue.body.trim().slice(0, 240)) && !TRACE.test(issue.body));
  if (looksLikeQuestion && !labels.some((l) => CONFIRMED_LABEL.test(l) || FEATURE_LABEL.test(l)) && !endorsed) return skip("reads as a question, not a change request");
  // "needs info" or "needs repro" means maintainers cannot act yet; an outsider cannot either, except by helping triage.
  const awaitingReporter = labels.find((l) => TRIAGE_LABEL.test(l));
  // A merged PR that references the issue suggests it is resolved, unless work is still open or the merge predates the issue.
  const mergedAfter = linkedPrs.filter((p) => p.state === "MERGED" && p.updatedAt > issue.createdAt);
  if (mergedAfter.length > 0 && !linkedPrs.some((p) => p.state === "OPEN")) return skip(`PR #${mergedAfter[0]!.number} referencing it was merged; likely resolved`);

  // Who is already on it?
  let novelty = 0.9;
  let noveltyReason = "no assignee, linked PR or recent claim";
  const openPr = linkedPrs.filter((p) => p.state === "OPEN").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const closedPr = linkedPrs.find((p) => p.state === "CLOSED");
  const claimComment = [...issue.lastComments].reverse().find((c) => c.body && c.author && !c.author.isBot && CLAIM.test(unquoted(c.body)) && !REJECT.test(unquoted(c.body)));
  const claim = claimComment ? { comment: claimComment, daysAgo: daysAgo(claimComment.createdAt, now) } : undefined;
  const maintainerOnIt = maintainerComments.find((c) => c.body && MAINTAINER_HANDLING.test(unquoted(c.body)) && daysAgo(c.createdAt, now) < 90);
  const inFlightLabel = labels.find((l) => IN_FLIGHT_LABEL.test(l));
  if (inFlightLabel) {
    novelty = 0.1;
    noveltyReason = `labelled "${inFlightLabel}": a fix is already underway`;
  } else if (openPr) {
    const prIdle = daysAgo(openPr.updatedAt, now);
    if (prIdle > 120) {
      novelty = 0.45;
      noveltyReason = `PR #${openPr.number} is open but idle for ${Math.round(prIdle)} days; it may be abandoned`;
    } else {
      novelty = 0.05;
      noveltyReason = `PR #${openPr.number} is open${openPr.isDraft ? " (draft)" : ""} and active`;
    }
  } else if (issue.assignees.length > 0) {
    novelty = idle > 90 ? 0.5 : 0.2;
    noveltyReason = `assigned to ${issue.assignees.join(", ")}${idle > 90 ? `, but no activity for ${Math.round(idle)} days` : ""}`;
  } else if (maintainerOnIt) {
    novelty = 0.15;
    noveltyReason = `a maintainer said they are handling it (${maintainerOnIt.createdAt.slice(0, 10)})`;
  } else if (claim) {
    if (claim.daysAgo < 45) {
      novelty = 0.2;
      noveltyReason = `${claim.comment.author?.login ?? "someone"} claimed it ${Math.round(claim.daysAgo)} days ago`;
    } else if (claim.daysAgo < 120) {
      novelty = 0.5;
      noveltyReason = `${claim.comment.author?.login ?? "someone"} claimed it ${Math.round(claim.daysAgo)} days ago with no PR since`;
    } else {
      novelty = 0.75;
      noveltyReason = `an old claim (${Math.round(claim.daysAgo)} days) went nowhere`;
    }
  } else if (closedPr) {
    novelty = 0.7;
    noveltyReason = `an earlier PR #${closedPr.number} was closed without merging`;
  }

  const result = { ...base, claim, novelty, noveltyReason };
  const triageEligible = nonAuthorComments.length === 0 && age >= 14 && !isMaintainer(issue.association) && repoResponsive && (labels.length === 0 || labels.some((l) => TRIAGE_LABEL.test(l)));
  if (isFeature && !isBug) {
    if (!endorsed && !confirmedLabel) {
      // An unanswered wish from an outsider is still worth a reply.
      if (triageEligible && !labels.some((l) => FEATURE_LABEL.test(l))) return { ...result, kind: "triage" };
      return { ...result, kind: "feature_request", skipReason: "feature request without maintainer endorsement or a help label" };
    }
    return { ...result, kind: "feature_request" };
  }
  if (awaitingReporter && !endorsed) {
    if (triageEligible || nonAuthorComments.length <= 2) return { ...result, kind: "triage" };
    return { ...result, kind: "issue", skipReason: `labelled "${awaitingReporter}": waiting on the reporter, nothing to fix yet` };
  }
  if (isBug || isDocs || confirmedLabel || endorsed) return { ...result, kind: "issue" };
  if (triageEligible) return { ...result, kind: "triage" };
  return { ...result, kind: "issue", skipReason: "unclear whether maintainers want this changed (no label, confirmation or repro)" };
}

export const issuesAnalyzer: Analyzer = {
  name: "issues",
  async run(ctx: AnalysisContext, profile: RepositoryProfile): Promise<Finding[]> {
    const samples = ctx.samples;
    if (!samples) return [];
    const responsive = profile.welcomeness.level !== "dormant" && profile.welcomeness.level !== "closed";
    const languages = profile.languages.slice(0, 2).map((l) => l.name.toLowerCase());
    const findings: Finding[] = [];
    const skippedReasons: string[] = [];
    let triage = 0;
    const hinted = new Set((ctx.options.hints?.issues ?? []).map((i) => i.number));
    const repoUrl = `https://${ctx.ref.host}/${ctx.ref.owner}/${ctx.ref.name}`;
    const assessments = samples.openIssues.map((issue) => ({ issue, a: assessIssue(issue, ctx.now, responsive, repoUrl) }));

    for (const { issue, a: lexical } of assessments) {
      let a = lexical;
      // Two open issues with near-identical titles: keep the older one as the opportunity, point the newer at it.
      const twin = a.skipReason ? undefined : findNearDuplicate(issue, samples.openIssues);
      if (twin && twin.createdAt < issue.createdAt && a.novelty > 0.5) a = { ...a, novelty: 0.5, noveltyReason: `looks like a duplicate of #${twin.number} ("${twin.title.slice(0, 60)}"); work there instead` };
      if (a.skipReason) {
        skippedReasons.push(`#${issue.number}: ${a.skipReason}`);
        continue;
      }
      if (a.kind === "triage") {
        if (triage >= 2) continue;
        triage++;
        findings.push(triageFinding(ctx, issue, a, profile));
        continue;
      }
      const finding = issueFinding(ctx, issue, a, profile, languages, hinted.has(issue.number));
      findings.push(finding);
    }
    // A compact tally first, so a thin or empty report still explains itself; the detailed list follows.
    const tally = new Map<string, number>();
    for (const reason of skippedReasons) {
      const category = /question/.test(reason) ? "questions" : /unclear|template-applied/.test(reason) ? "unconfirmed or unclear" : /endorsement/.test(reason) ? "features without maintainer endorsement" : /is open|assigned|claimed|underway|merged|resolved/.test(reason) ? "already in flight or resolved" : /pushed back|labelled|locked|duplicate|waiting on the reporter|model/.test(reason) ? "declined, labelled out, or waiting on the reporter" : "other";
      tally.set(category, (tally.get(category) ?? 0) + 1);
    }
    const accepted = findings.filter((f) => f.kind !== "triage").length;
    ctx.budget.note(`issues reviewed: ${assessments.length}; accepted ${accepted}, triage ${findings.length - accepted}${tally.size ? `; passed over: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}`);
    if (skippedReasons.length) ctx.budget.note(`issues passed over: ${skippedReasons.slice(0, 12).join("; ")}${skippedReasons.length > 12 ? `; +${skippedReasons.length - 12} more` : ""}`);
    return findings;
  },
};

const STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "with", "and", "or", "is", "are", "not", "when", "using", "after", "from", "by", "at", "as", "it", "this", "that", "be", "does", "doesn", "t", "s", "if", "error", "bug", "issue", "fix", "problem"]);
function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/`[^`]*`/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

/** Another open issue whose title shares most of its words: likely the same report. */
export function findNearDuplicate(issue: IssueSample, others: IssueSample[]): IssueSample | undefined {
  const mine = titleTokens(issue.title);
  if (mine.size < 3) return undefined;
  let best: { issue: IssueSample; score: number } | undefined;
  for (const other of others) {
    if (other.number === issue.number) continue;
    const theirs = titleTokens(other.title);
    if (theirs.size < 3) continue;
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    const score = shared / (mine.size + theirs.size - shared);
    if (score >= 0.6 && (!best || score > best.score)) best = { issue: other, score };
  }
  return best?.issue;
}

/** Issue body without code blocks, HTML comments, headings and emphasis. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function issueRef(issue: IssueSample, inFlight: boolean): IssueRef {
  return { number: issue.number, url: issue.url, title: issue.title, labels: issue.labels, assignees: issue.assignees, inFlight, createdAt: issue.createdAt, updatedAt: issue.updatedAt };
}

function mentionedFiles(ctx: AnalysisContext, text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN)) {
    const token = m[1]!;
    const hit = ctx.inventory.byPath.has(token) ? token : ctx.inventory.files.find((f) => !f.vendored && (f.path.endsWith(`/${token}`) || f.path === token))?.path;
    if (hit && !found.includes(hit)) found.push(hit);
    if (found.length >= 5) break;
  }
  return found;
}

function issueFinding(ctx: AnalysisContext, issue: IssueSample, a: IssueAssessment, profile: RepositoryProfile, languages: string[], hinted: boolean): Finding {
  const feature = a.kind === "feature_request";
  const age = daysAgo(issue.createdAt, ctx.now);
  const idle = daysAgo(issue.updatedAt, ctx.now);
  const bodyLen = issue.body.trim().length;
  const files = mentionedFiles(ctx, `${issue.title}\n${issue.body}`);

  let value = feature ? 0.45 : 0.5;
  const valueWhy: string[] = [feature ? "maintainer-endorsed feature" : "open defect"];
  if (a.confirmedLabel) { value += 0.15; valueWhy.push(`labelled "${a.confirmedLabel}"`); }
  if (a.endorsed) { value += 0.1; valueWhy.push("maintainer endorsed in comments"); }
  if (issue.reactions > 0) { value += Math.min(0.15, issue.reactions * 0.02); valueWhy.push(`${issue.reactions} reactions`); }
  if (issue.commentCount >= 3) { value += 0.05; valueWhy.push(`${issue.commentCount} comments`); }
  if (a.hasTrace) { value += 0.1; valueWhy.push("crash or stack trace reported"); }
  if (hinted) { value += 0.05; valueWhy.push("selected by discovery"); }
  if (age > 365 * 4 && idle > 365 * 2) { value *= 0.55; valueWhy.push("many years old with no recent activity; likely stale or implicitly declined"); }
  else if (age > 730 && idle > 365) { value *= 0.8; valueWhy.push("old and quiet; may be outdated"); }

  let feasibility = 0.4;
  const feasWhy: string[] = [];
  if (a.hasRepro || a.hasTrace) { feasibility += 0.2; feasWhy.push("reproduction steps or trace included"); }
  if (a.easy) { feasibility += 0.15; feasWhy.push("labelled easy"); }
  if (files.length) { feasibility += 0.1; feasWhy.push(`mentions ${files[0]}`); }
  if (bodyLen < 80) { feasibility -= 0.15; feasWhy.push("very short description"); }
  if (a.hard) { feasibility -= 0.2; feasWhy.push("labelled as hard or needing design"); }
  if (feature) { feasibility -= 0.1; feasWhy.push("features need design agreement"); }
  if (feasWhy.length === 0) feasWhy.push("no reproduction, label or file hints; expect investigation");

  const effort = a.easy ? "small" : feature ? (/\b(breaking|architecture|rewrite|redesign)\b/i.test(issue.body) ? "large" : "medium") : a.hasRepro || a.hasTrace ? "small" : "medium";
  const etiquette: string[] = [];
  if (a.novelty < 0.9) etiquette.push(`Comment on #${issue.number} first: ${a.noveltyReason}.`);
  else etiquette.push(`Comment on #${issue.number} that you are starting, so nobody duplicates the work.`);
  if (a.claim && a.claim.daysAgo >= 45) etiquette.push(`Politely ask ${a.claim.comment.author?.login ?? "the earlier claimant"} whether they are still working on it before you start.`);
  const risks: string[] = [];
  if (age > 365) risks.push(`Opened ${Math.round(age / 365 * 10) / 10} years ago; confirm it still reproduces on the default branch.`);
  if (/earlier PR #\d+ was closed/.test(a.noveltyReason)) risks.push("A previous PR was closed without merging; read its review to learn what maintainers rejected.");
  if (!a.endorsed && !a.confirmedLabel) risks.push("No maintainer has confirmed the issue; ask before investing heavily.");

  const ev = [evidence(ctx, "issue", issue.url, { excerpt: issue.title, note: `labels: ${issue.labels.join(", ") || "none"}; ${issue.commentCount} comments; ${issue.reactions} reactions; opened ${issue.createdAt.slice(0, 10)}` })];
  if (a.endorsed) ev.push(evidence(ctx, "issue", `${issue.url}#issuecomment`, { excerpt: truncate(a.endorsed.body ?? "", 200), note: `maintainer (${a.endorsed.association.toLowerCase()}) on ${a.endorsed.createdAt.slice(0, 10)}` }));
  if (a.claim) ev.push(evidence(ctx, "issue", `${issue.url}#issuecomment`, { excerpt: truncate(a.claim.comment.body ?? "", 160), note: `claim by ${a.claim.comment.author?.login ?? "unknown"} ${Math.round(a.claim.daysAgo)} days ago` }));
  for (const pr of issue.linkedPrs.filter((p) => isSameRepoPr(p.url, `https://${ctx.ref.host}/${ctx.ref.owner}/${ctx.ref.name}`))) ev.push(evidence(ctx, "pull_request", pr.url, { note: `linked PR is ${pr.state.toLowerCase()}${pr.isDraft ? " (draft)" : ""}, updated ${pr.updatedAt.slice(0, 10)}` }));

  const signals: FindingSignals = {
    value: Math.min(0.95, value), valueReason: valueWhy.join("; "),
    feasibility: Math.max(0.1, Math.min(0.95, feasibility)), feasibilityReason: feasWhy.join("; "),
    confidence: a.confirmedLabel || a.endorsed ? 0.85 : 0.6,
    confidenceReason: a.confirmedLabel || a.endorsed ? "maintainers labelled or confirmed it" : "inferred from the issue text alone",
    novelty: a.novelty, noveltyReason: a.noveltyReason,
    welcomenessFactor: a.confirmedLabel ? 1.1 : 1,
    welcomenessReason: a.confirmedLabel ? `help label "${a.confirmedLabel}" invites contributions` : undefined,
  };
  return {
    kind: a.kind,
    clusterKey: `issue:${issue.number}`,
    title: `${feature ? "Implement" : a.isDocs ? "Improve docs:" : "Fix"} #${issue.number}: ${truncate(issue.title, 90)}`,
    summary: truncate(plainText(issue.body), 300) || issue.title,
    evidence: ev,
    files,
    effort,
    skills: [...languages, feature ? "design" : a.isDocs ? "docs" : "debugging"],
    approach: feature
      ? [`Restate the agreed design from #${issue.number} in a comment and confirm scope.`, "Implement behind the existing public API conventions; add tests and docs.", `Open the PR with "Closes #${issue.number}".`]
      : [a.hasRepro ? `Reproduce using the steps in #${issue.number} on the default branch.` : `Write a minimal reproduction for #${issue.number} first; post it on the issue.`, files.length ? `Start in ${files.slice(0, 2).join(" and ")}.` : "Locate the code path from the error message or feature name.", "Add a regression test, then fix.", `Open the PR with "Fixes #${issue.number}".`],
    acceptanceCriteria: [feature ? "Behaviour described in the issue works and is covered by tests." : "The reported behaviour no longer occurs and a test guards against regression.", "Existing tests pass."],
    etiquette,
    risks,
    issue: issueRef(issue, a.novelty < 0.5),
    signals,
  };
}

function triageFinding(ctx: AnalysisContext, issue: IssueSample, a: IssueAssessment, profile: RepositoryProfile): Finding {
  const age = Math.round(daysAgo(issue.createdAt, ctx.now));
  return {
    kind: "triage",
    clusterKey: `issue:${issue.number}`,
    title: `Triage #${issue.number}: ${truncate(issue.title, 90)}`,
    summary: `Opened ${age} days ago by an outside user and nobody has replied. ${a.hasRepro ? "It includes reproduction details, so it can be confirmed or refuted." : "It lacks details, so a good first reply asks for a reproduction."}`,
    evidence: [evidence(ctx, "issue", issue.url, { excerpt: issue.title, note: `0 replies after ${age} days; labels: ${issue.labels.join(", ") || "none"}` })],
    files: [],
    effort: "trivial",
    skills: ["communication", ...profile.languages.slice(0, 1).map((l) => l.name.toLowerCase())],
    approach: a.hasRepro
      ? ["Try to reproduce on the default branch and report exactly what you observed, with versions.", "If it reproduces, say so and suggest a label; if not, ask what differs in the reporter's setup."]
      : ["Ask for the version, platform, and a minimal reproduction, pointing to the issue template if one exists.", "Link related issues if you find any."],
    acceptanceCriteria: ["The issue has a reply that moves it toward confirmed or closed."],
    etiquette: ["You are not a maintainer: offer findings, do not promise fixes or close issues."],
    risks: ["Maintainers may already be aware and simply backlogged."],
    issue: issueRef(issue, false),
    signals: {
      value: Math.min(0.4, 0.2 + issue.reactions * 0.03),
      valueReason: "unblocks a reporter and saves maintainer time; no code changes",
      feasibility: a.hasRepro ? 0.8 : 0.9,
      feasibilityReason: "needs only a local run or a careful reply",
      confidence: 0.9,
      confidenceReason: "comment count and ages come from the API",
      welcomenessFactor: 0.9,
    },
  };
}
