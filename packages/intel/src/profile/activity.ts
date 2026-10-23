import type { Activity, HotFile } from "../contracts.ts";
import type { FileInventory } from "../fs/scan.ts";
import type { Commit } from "../git/repo.ts";
import type { GitHubSamples, IssueSample, PrSample, Release } from "../github/types.ts";
import { isBotLogin, isMaintainer } from "../github/types.ts";
import { daysBetween, hoursBetween, isoDaysBefore, median } from "../util/time.ts";

export interface ActivityInput {
  commits: Commit[];
  samples: GitHubSamples | undefined;
  releases: Release[];
  pushedAt: string | undefined;
  openIssues: number;
  openPrs: number;
  now: Date;
}

function externalPrsAll(samples: ActivityInput["samples"]) {
  return [...(samples?.closedPrs ?? []), ...(samples?.openPrs ?? [])].filter((p) => isExternal(p) && !p.author?.isBot);
}

export function computeActivity(input: ActivityInput): Activity {
  const { commits, samples, releases, now } = input;
  const since90 = isoDaysBefore(now, 90);
  const human = commits.filter((c) => !isBotLogin(c.authorName) && !isBotLogin(c.authorEmail.split("@")[0] ?? ""));
  const recent90 = human.filter((c) => c.date >= since90);

  const externalClosed = (samples?.closedPrs ?? []).filter((p) => isExternal(p) && !p.author?.isBot);
  const merged = externalClosed.filter((p) => p.merged).length;

  // Items known to have comments whose text was not fetched (forge APIs cost one call per item) are unknown, not silent.
  const fetched = (commentCount: number, comments: unknown[]) => commentCount === 0 || comments.length > 0;
  // When many items' comments could not be read (GitLab without a token), the readable rest is mostly the unanswered
  // ones, and their median would describe only those: report the response time as unknown instead.
  const mostlyUnread = <T extends { commentsFetched?: boolean | undefined }>(items: T[]) => items.length > 0 && items.filter((x) => x.commentsFetched === false).length > items.length * 0.2;
  const externalIssues = [...(samples?.openIssues ?? []), ...(samples?.closedIssues ?? [])].filter((i) => isExternal(i) && !i.author?.isBot);
  const prResponses = (mostlyUnread(externalPrsAll(samples)) ? [] : [...(samples?.closedPrs ?? []), ...(samples?.openPrs ?? [])])
    .filter((p) => isExternal(p) && !p.author?.isBot && p.commentsFetched !== false)
    .map((p) => firstResponseHours(p.createdAt, p.author?.login, [...p.firstComments, ...p.reviews], now))
    .filter((h): h is number => h !== undefined);
  const issueResponses = (mostlyUnread(externalIssues) ? [] : [...(samples?.openIssues ?? []), ...(samples?.closedIssues ?? [])])
    .filter((i) => isExternal(i) && !i.author?.isBot && i.commentsFetched !== false && fetched(i.commentCount, i.firstComments))
    .map((i) => firstResponseHours(i.createdAt, i.author?.login, i.firstComments, now))
    .filter((h): h is number => h !== undefined);

  const published = releases.filter((r) => !r.prerelease).map((r) => r.publishedAt).sort().reverse();
  const gaps: number[] = [];
  for (let i = 0; i + 1 < published.length && i < 5; i++) gaps.push(daysBetween(published[i + 1]!, published[i]!));

  const activity: Activity = {
    commits90d: recent90.length,
    commits365d: human.length,
    authors90d: new Set(recent90.map((c) => c.authorEmail.toLowerCase())).size,
    authors365d: new Set(human.map((c) => c.authorEmail.toLowerCase())).size,
    busFactor: busFactor(human),
    openIssues: input.openIssues,
    openPullRequests: input.openPrs,
    sampleSizes: {
      issues: issueResponses.length,
      pullRequests: prResponses.length,
      externalPullRequests: externalClosed.length,
    },
  };
  if (input.pushedAt) activity.lastPushAt = input.pushedAt;
  if (published[0]) activity.lastReleaseAt = published[0];
  const cadence = median(gaps);
  if (cadence !== undefined) activity.releaseCadenceDays = Math.round(cadence);
  const prMedian = median(prResponses);
  if (prMedian !== undefined) activity.medianPrResponseHours = Math.round(prMedian * 10) / 10;
  const issueMedian = median(issueResponses);
  if (issueMedian !== undefined) activity.medianIssueResponseHours = Math.round(issueMedian * 10) / 10;
  if (externalClosed.length >= 3) activity.externalPrMergeRate = Math.round((merged / externalClosed.length) * 100) / 100;
  return activity;
}

export function isExternal(item: Pick<IssueSample, "association">): boolean {
  return !isMaintainer(item.association);
}

/**
 * Hours until someone other than the author replied. Open items with no reply
 * count as "at least this long" so silence is not invisible in the median.
 */
export function firstResponseHours(
  createdAt: string,
  authorLogin: string | undefined,
  responses: { createdAt: string; author: { login: string; isBot: boolean } | undefined }[],
  now: Date,
): number | undefined {
  const replies = responses
    .filter((r) => r.author && !r.author.isBot && r.author.login !== authorLogin)
    .map((r) => hoursBetween(createdAt, r.createdAt))
    .filter((h) => h >= 0);
  if (replies.length > 0) return Math.min(...replies);
  const age = hoursBetween(createdAt, now);
  // Fresh items without a reply are not evidence of slowness yet.
  return age > 72 ? age : undefined;
}

/** Smallest number of authors who made at least half of the commits. */
export function busFactor(commits: Commit[]): number {
  if (commits.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of commits) counts.set(c.authorEmail.toLowerCase(), (counts.get(c.authorEmail.toLowerCase()) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  let covered = 0;
  for (let i = 0; i < sorted.length; i++) {
    covered += sorted[i]!;
    if (covered * 2 >= commits.length) return i + 1;
  }
  return sorted.length;
}

/** Most frequently changed non-vendored files in the window. */
export function hotFiles(commits: Commit[], inventory: FileInventory, limit = 15): HotFile[] {
  const stats = new Map<string, { commits: number; authors: Set<string> }>();
  for (const c of commits) {
    for (const path of c.files) {
      const entry = inventory.byPath.get(path);
      if (!entry || entry.vendored || (entry.category !== "source" && entry.category !== "test")) continue;
      const s = stats.get(path) ?? { commits: 0, authors: new Set<string>() };
      s.commits++;
      s.authors.add(c.authorEmail.toLowerCase());
      stats.set(path, s);
    }
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].commits - a[1].commits)
    .slice(0, limit)
    .map(([path, s]) => ({ path, commits365d: s.commits, authors365d: s.authors.size }));
}
