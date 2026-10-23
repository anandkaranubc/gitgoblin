import type { Activity, ContributionRules, Evidence, Welcomeness, WelcomenessLevel, WelcomenessSignal } from "../contracts.ts";
import type { FileInventory } from "../fs/scan.ts";
import type { GitHubSamples, RepoMeta } from "../github/types.ts";
import { isMaintainer } from "../github/types.ts";
import { daysAgo } from "../util/time.ts";
import { stableId, truncate } from "../util/text.ts";
import { isExternal } from "./activity.ts";

export interface WelcomenessInput {
  meta: RepoMeta;
  samples: GitHubSamples | undefined;
  activity: Activity;
  inventory: FileInventory;
  /** Text of CONTRIBUTING, README (first part), and PR template, when present. */
  docs: { contributing?: string | undefined; readme?: string | undefined; prTemplate?: string | undefined };
  now: Date;
}

const HELP_LABEL = /help[- _]?wanted|good[- _]first[- _]issue|good first|beginner|starter|newcomer|first[- _]timers?|up[- _]for[- _]grabs|contributions? welcome|\beasy\b|low[- _]hanging|e-easy|d: easy|difficulty: easy|hacktoberfest/i;

export function assessWelcomeness(input: WelcomenessInput): Welcomeness {
  const { meta, samples, activity, now } = input;
  const signals: WelcomenessSignal[] = [];
  const nowIso = now.toISOString();
  const ev = (kind: Evidence["kind"], locator: string, note: string, excerpt?: string): Evidence => {
    const e: Evidence = { id: stableId("ev", kind, locator, note), kind, locator, note, observedAt: nowIso };
    if (excerpt) e.excerpt = truncate(excerpt, 200);
    return e;
  };
  const push = (signal: string, weight: number, evidence: Evidence) => signals.push({ signal, weight, evidence });
  const repoApi = `/repos/${meta.owner}/${meta.name}`;
  const rules = extractRules(input);

  let closed: string | undefined;
  if (meta.archived) {
    closed = "repository is archived";
    push(closed, -1, ev("api", repoApi, "archived: true"));
  } else if (meta.disabled) {
    closed = "repository is disabled";
    push(closed, -1, ev("api", repoApi, "disabled: true"));
  } else if (samples?.isMirror || /\b(read[- ]only )?mirror of\b/i.test(input.docs.readme?.slice(0, 1500) ?? "")) {
    closed = "repository is a read-only mirror";
    push(closed, -1, ev("api", repoApi, "mirror"));
  } else if (findDeprecationNotice(input.docs.readme, meta.description)) {
    const notice = findDeprecationNotice(input.docs.readme, meta.description)!;
    closed = "project declares itself deprecated or unmaintained";
    push(closed, -1, ev("file", notice.where, "deprecation notice", notice.sentence));
  } else {
    const refusal = findRefusal(input.docs.contributing) ?? findRefusal(input.docs.readme);
    if (refusal) {
      closed = "maintainers say they are not accepting contributions";
      push(closed, -1, ev("file", refusal.path, "statement in project docs", refusal.sentence));
    }
  }
  if (closed) return { score: 0, level: "closed", signals, rules };

  // Liveness
  const pushAge = activity.lastPushAt ? daysAgo(activity.lastPushAt, now) : undefined;
  if (pushAge !== undefined && pushAge > 365) push("no push in over a year", -0.4, ev("api", repoApi, `pushed_at ${activity.lastPushAt}`));
  else if (pushAge !== undefined && pushAge > 180) push("no push in six months", -0.2, ev("api", repoApi, `pushed_at ${activity.lastPushAt}`));
  if (activity.commits365d === 0 && !(pushAge !== undefined && pushAge > 365)) push("no commits in the last year", -0.3, ev("computed", "git log --since=365d", "0 non-merge commits"));
  else if (activity.commits90d >= 10) push("active development in the last 90 days", 0.05, ev("computed", "git log --since=90d", `${activity.commits90d} commits`));

  // Behaviour toward outsiders
  const rate = activity.externalPrMergeRate;
  const n = activity.sampleSizes.externalPullRequests;
  if (rate !== undefined) {
    const note = `${Math.round(rate * 100)}% of ${n} recently closed PRs from non-maintainers were merged`;
    // Whether outsiders' work lands is the single most telling signal, so it carries the most weight.
    if (rate >= 0.6) push("most outside PRs get merged", 0.3, ev("computed", "GraphQL closed pull requests", note));
    else if (rate >= 0.3) push("a fair share of outside PRs get merged", 0.15, ev("computed", "GraphQL closed pull requests", note));
    else if (n >= 5 && rate < 0.2) push("outside PRs are mostly closed without merging", -0.35, ev("computed", "GraphQL closed pull requests", note));
    else if (n >= 5) push("fewer than a third of outside PRs get merged", -0.15, ev("computed", "GraphQL closed pull requests", note));
  }
  let slowPrs = false;
  const prHours = activity.medianPrResponseHours;
  if (prHours !== undefined && activity.sampleSizes.pullRequests >= 3) {
    const note = `median ${Math.round(prHours)}h to first response on ${activity.sampleSizes.pullRequests} outside PRs`;
    if (prHours <= 72) push("outside PRs get a response within days", 0.15, ev("computed", "GraphQL pull request comments and reviews", note));
    else if (prHours <= 24 * 14) push("outside PRs get a response within two weeks", 0.05, ev("computed", "GraphQL pull request comments and reviews", note));
    else if (prHours > 24 * 30) {
      slowPrs = true;
      push("outside PRs wait over a month for a response", -0.2, ev("computed", "GraphQL pull request comments and reviews", note));
    }
  }
  let slowIssues = false;
  const issueHours = activity.medianIssueResponseHours;
  if (issueHours !== undefined && activity.sampleSizes.issues >= 3) {
    const note = `median ${Math.round(issueHours)}h to first response on ${activity.sampleSizes.issues} outside issues`;
    if (issueHours <= 72) push("issues get answered within days", 0.1, ev("computed", "GraphQL issue comments", note));
    else if (issueHours > 24 * 90) {
      slowIssues = true;
      push("issues wait months for an answer", -0.2, ev("computed", "GraphQL issue comments", note));
    }
    else if (issueHours > 24 * 30) push("issues wait over a month for an answer", -0.1, ev("computed", "GraphQL issue comments", note));
  }
  if (samples) {
    const staleExternal = samples.openPrs.filter(
      (p) => isExternal(p) && !p.author?.isBot && !p.isDraft && p.commentsFetched !== false && daysAgo(p.createdAt, now) > 30 &&
        ![...p.firstComments, ...p.reviews].some((c) => c.author && !c.author.isBot && c.author.login !== p.author?.login),
    );
    if (samples.openPrs.length >= 5 && staleExternal.length / samples.openPrs.length > 0.5) {
      // Overlaps with the slow-response signal above; count the backlog once.
      push("most open outside PRs have never had a response", slowPrs ? -0.1 : -0.3, ev("computed", "GraphQL open pull requests", `${staleExternal.length} of ${samples.openPrs.length} open PRs are from outsiders, over 30 days old, with no reply`));
    }
    const recentMerges = samples.closedPrs.filter((p) => p.merged && isExternal(p) && !p.author?.isBot && p.mergedAt && daysAgo(p.mergedAt, now) <= 90);
    if (recentMerges.length >= 3) push("merged outside PRs in the last 90 days", 0.1, ev("pull_request", recentMerges[0]!.url, `${recentMerges.length} outside PRs merged recently, e.g. #${recentMerges[0]!.number}`));
    const firstTimers = samples.closedPrs.filter((p) => p.merged && (p.association === "FIRST_TIME_CONTRIBUTOR" || p.association === "FIRST_TIMER"));
    if (firstTimers.length > 0) push("merges first-time contributors", 0.1, ev("pull_request", firstTimers[0]!.url, `#${firstTimers[0]!.number} was a first contribution`));
    const openWithHelp = samples.labels.filter((l) => HELP_LABEL.test(l.name) && l.openIssues > 0);
    if (openWithHelp.length > 0) push("has open issues labelled for help", 0.15, ev("api", `${repoApi}/labels`, openWithHelp.map((l) => `${l.name} (${l.openIssues})`).join(", ")));
    else if (rules.helpLabels.length > 0) push("has help labels but none open", 0.05, ev("api", `${repoApi}/labels`, rules.helpLabels.join(", ")));
  }

  // Paperwork, lightly weighted
  if (rules.contributingPath) push("has a contributing guide", 0.1, ev("file", rules.contributingPath, "CONTRIBUTING present"));
  if (rules.pullRequestTemplate) push("has a pull request template", 0.05, ev("file", rules.pullRequestTemplatePath ?? ".github", "PR template present"));
  if (activity.busFactor === 1 && activity.authors365d <= 1 && activity.commits365d > 0) {
    push("single-maintainer project", -0.1, ev("computed", "git log --since=365d", "one author in the last year"));
  }

  // Only hard signals produce 0 (closed); everything else keeps a small floor.
  let score = Math.max(0.05, clamp(0.5 + signals.reduce((s, x) => s + x.weight, 0)));
  // Dormant means nobody is home. A project that still commits or answers issues is selective at worst.
  const alive =
    activity.commits90d >= 3 ||
    (issueHours !== undefined && issueHours <= 24 * 30 && activity.sampleSizes.issues >= 3) ||
    (rate !== undefined && rate >= 0.2 && n >= 20);
  if (score < 0.25 && alive) {
    push("floored at selective: maintainers still commit, answer issues or merge outside PRs", 0, ev("computed", "git log and GraphQL samples", `${activity.commits90d} commits in 90 days; median issue reply ${issueHours === undefined ? "unknown" : `${Math.round(issueHours)}h`}; ${rate === undefined ? "merge rate unknown" : `${Math.round(rate * 100)}% of ${n} outside PRs merged`}`));
    score = 0.25;
  }
  // Eager means outsiders are answered quickly and merged often; paperwork alone cannot earn it. "Quickly" needs
  // evidence: every known median reply time within two weeks, and at least one of them known.
  const replyTimes = [prHours, issueHours].filter((h): h is number => h !== undefined);
  const quickReplies = replyTimes.length > 0 && replyTimes.every((h) => h <= 24 * 14);
  if (score >= 0.8 && (slowIssues || slowPrs || !quickReplies || (rate !== undefined && rate < 0.5))) {
    const why = replyTimes.length === 0 ? "reply times unknown; " : !quickReplies ? `median replies ${replyTimes.map((h) => `${Math.round(h / 24)}d`).join(" and ")}; ` : "";
    push("capped at open: eager needs replies within two weeks and a merge rate of at least 50%", 0, ev("computed", "GraphQL samples", `${why}${rate !== undefined ? `${Math.round(rate * 100)}% merged` : "merge rate unknown"}`));
    score = 0.79;
  }
  // Fast replies cannot make up for rarely merging outside work: cap at selective.
  if (rate !== undefined && rate < 0.2 && n >= 20 && score >= 0.5) {
    push("capped at selective: fewer than 20% of outside PRs are merged", 0, ev("computed", "GraphQL closed pull requests", `${Math.round(rate * 100)}% of ${n} outside PRs merged`));
    score = 0.45;
  }
  return { score, level: levelFor(score), signals, rules };
}

export function levelFor(score: number): WelcomenessLevel {
  if (score <= 0) return "closed";
  if (score < 0.25) return "dormant";
  if (score < 0.5) return "selective";
  if (score < 0.8) return "open";
  return "eager";
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, Math.round(x * 100) / 100));
}

// A refusal names who refuses and is unconditional: "we are not accepting pull requests", not "we may not review PRs which fail tests".
const REFUSAL = /\b(?:we|i|this (?:project|repository|repo|library|package|fork)|the (?:project|maintainers?|team|authors?)|maintainers?)[ \t]{0,5}(?:are|is|am|'re|'m|will be|do|does)?[ \t]{0,5}(?:currently[ \t]{1,5})?(?:not|n't|never|no longer)\s+(?:currently\s+|actively\s+)?(?:accept(?:ing)?|taking|looking for|open to|seeking)\s+(?:any\s+|external\s+|outside\s+|new\s+|unsolicited\s+|community\s+|public\s+)?(?:contributions|pull requests|prs|patches|merge requests)\b/i;
const COSMETIC = /typo|spelling|grammar|whitespace|formatting|cosmetic|style[- ]only|trivial|drive-by|dependency|version bump|badge|refactor|hacktoberfest|at this time for features|feature/i;

/** A sentence saying contributions are not accepted at all, as opposed to one kind of change. */
export function findRefusal(text: string | undefined, path = "CONTRIBUTING.md"): { sentence: string; path: string } | undefined {
  if (!text) return undefined;
  for (const sentence of sentences(text)) {
    if (REFUSAL.test(sentence) && !COSMETIC.test(sentence) && !/\bunless\b|\bexcept\b|\bwithout (first )?(opening|filing)|\bmay\b|\bmight\b|\bwhich\b|\bthat (?:aren'?t|don'?t|do not|are not|lack|fail)|\buntil\b|\bif\b/i.test(sentence)) {
      return { sentence: sentence.trim(), path };
    }
  }
  return undefined;
}

const DEPRECATED_HEADING = /^\s{0,3}#{1,6}\s*[^\n]{0,20}\b(deprecated|unmaintained|archived|discontinued|end of life|no longer maintained)\b/im;
const DEPRECATED_SENTENCE = /\b(this (project|package|library|module|repo(sitory)?|gem|crate|tool|plugin|extension|fork)|the project|it) (is|has been|was) (now )?(officially )?(deprecated|discontinued|abandoned|archived|unmaintained|no longer (maintained|supported|actively developed|being developed)|not (actively )?maintained|end of life|in maintenance mode and will not)|\bno longer (maintained|actively maintained|supported|under development)\b|\b(unmaintained|deprecated) (project|package|library)\b|\bplease use \[?[\w./@-]+\]? instead\b/i;

/** Reason a repository is closed to contributions that needs no API samples, or undefined. */
export function earlyClosedReason(meta: Pick<RepoMeta, "archived" | "disabled" | "description">, readme: string | undefined, contributing: string | undefined): string | undefined {
  if (meta.archived) return "repository is archived";
  if (meta.disabled) return "repository is disabled";
  if (findDeprecationNotice(readme, meta.description)) return "project declares itself deprecated or unmaintained";
  if (findRefusal(contributing) ?? findRefusal(readme, "README.md")) return "maintainers say they are not accepting contributions";
  return undefined;
}

/** A README or description saying the project itself is dead. Only the top of the README counts. */
export function findDeprecationNotice(readme: string | undefined, description: string | undefined): { sentence: string; where: string } | undefined {
  const desc = description ?? "";
  if (/\b(deprecated|unmaintained|no longer maintained|archived|discontinued|abandoned)\b/i.test(desc) && !/\b(deprecat\w+ (warnings?|apis?|functions?|features?)|detect|find|check|lint)\b/i.test(desc)) {
    return { sentence: desc, where: "repository description" };
  }
  const head = (readme ?? "").slice(0, 2500);
  const heading = DEPRECATED_HEADING.exec(head);
  if (heading) return { sentence: heading[0].trim(), where: "README.md" };
  for (const sentence of sentences(head)) {
    if (DEPRECATED_SENTENCE.test(sentence) && !/\b(deprecat\w+ (warnings?|apis?|functions?|features?|options?|methods?)|will be deprecated|were deprecated)\b/i.test(sentence)) {
      return { sentence: truncate(sentence, 200), where: "README.md" };
    }
  }
  return undefined;
}

const REJECT_CUE = /\b(?:do not|don't|won't|will not|not accept|not be accepted|not merge|be closed|please avoid|avoid|discourage|no longer accept|unwelcome|not welcome|reject)\b/i;
const REJECT_KIND = /\b(typos?|spelling|grammar|whitespace|formatting|cosmetic|style[- ]only|refactor\w*|rewrite|drive-by|trivial|dependency (?:bumps?|updates?)|version bumps?|badges?|hacktoberfest|large (?:prs?|pull requests?)|unsolicited|new features?|feature requests?|breaking changes?|translations?)\b/i;

export function extractRules(input: Pick<WelcomenessInput, "inventory" | "docs" | "samples">): ContributionRules {
  const paths = input.inventory.files.map((f) => f.path);
  const find = (re: RegExp) => paths.find((p) => re.test(p));
  const contributingPath = find(/^(\.github\/|docs?\/)?contributing(\.\w+)?$/i);
  const codeOfConductPath = find(/^(\.github\/|docs?\/)?code[-_]of[-_]conduct(\.\w+)?$/i);
  const prTemplatePath = find(/^(\.github\/|docs?\/)?pull_request_template(\.\w+)?$/i) ?? find(/^\.github\/PULL_REQUEST_TEMPLATE\//);
  const texts = [input.docs.contributing ?? "", input.docs.prTemplate ?? ""].join("\n");
  const rejected: string[] = [];
  for (const sentence of sentences(`${input.docs.contributing ?? ""}\n${input.docs.readme ?? ""}`)) {
    if (REJECT_CUE.test(sentence) && REJECT_KIND.test(sentence) && sentence.length < 400) {
      rejected.push(truncate(sentence, 220));
      if (rejected.length >= 6) break;
    }
  }
  const rules: ContributionRules = {
    requiresIssueFirst: /\b(open|file|create|start|raise)\b[^.]{0,60}\b(issue|discussion)\b[^.]{0,80}\b(before|prior to|first)\b/i.test(texts) || /\b(before|prior to)\b[^.]{0,80}\b(open|submit|send|creat)\w*\s+(a\s+)?(pull request|pr)\b[^.]{0,80}\b(issue|discussion)\b/i.test(texts),
    cla: /\bCLA\b|contributor license agreement/i.test(texts),
    dco: /\bDCO\b|developer certificate of origin|signed-off-by/i.test(texts),
    issueTemplates: paths.some((p) => /^\.github\/ISSUE_TEMPLATE\//i.test(p) || /^\.github\/issue_template(\.\w+)?$/i.test(p)),
    pullRequestTemplate: prTemplatePath !== undefined,
    helpLabels: (input.samples?.labels ?? []).filter((l) => HELP_LABEL.test(l.name)).map((l) => l.name),
    rejectedChanges: rejected,
    dependencyBot: paths.some((p) => /^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(\.json)?|\.github\/renovate\.json5?)$/.test(p)),
    requiresTests: /\b(include|add|write|with|accompan\w+|require\w*)\b[^.]{0,40}\btests?\b/i.test(texts) || /\[ \][^\n]*\btests?\b/i.test(input.docs.prTemplate ?? ""),
    requiresChangelog: /\bchangelog\b|CHANGES\.(md|rst)|news fragment|towncrier|changeset/i.test(texts),
  };
  if (contributingPath) rules.contributingPath = contributingPath;
  if (codeOfConductPath) rules.codeOfConductPath = codeOfConductPath;
  if (prTemplatePath) rules.pullRequestTemplatePath = prTemplatePath;
  return rules;
}

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*#])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

export { isMaintainer };
