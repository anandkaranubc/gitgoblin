/**
 * E3, second half: of the pull requests outsiders got merged in the year
 * before T, what kind of change were they, with and without an issue behind
 * them? Re-reads the cached history, so it costs one files query per
 * repository.
 */
import { createSources } from "@gitgoblin/sources";
import type { BacktestDataset } from "./discovery-backtest.ts";
import { fetchHistory, fetchPrFiles } from "./github/history.ts";
import { type ChangeKind, classifyChange } from "./kinds.ts";
import { seededRandom } from "./metrics.ts";
import { MAINTAINER_ASSOCIATIONS } from "./outcomes.ts";

const DAY_MS = 86_400_000;

export interface KindCount {
  withIssue: number;
  withoutIssue: number;
}

export interface KindsDataset {
  experiment: "tracker-kinds";
  asOf: string;
  fetchedAt: string;
  repositories: number;
  sampledPullRequests: number;
  byKind: Record<ChangeKind, KindCount>;
  byLanguage: Record<string, Record<ChangeKind, KindCount>>;
}

function emptyCounts(): Record<ChangeKind, KindCount> {
  return { docs: { withIssue: 0, withoutIssue: 0 }, ci: { withIssue: 0, withoutIssue: 0 }, tests: { withIssue: 0, withoutIssue: 0 }, dependencies: { withIssue: 0, withoutIssue: 0 }, code: { withIssue: 0, withoutIssue: 0 }, mixed: { withIssue: 0, withoutIssue: 0 } };
}

export async function fetchKinds(dataset: BacktestDataset, options: { perRepo?: number | undefined; cachePath?: string | undefined; seed?: number | undefined; log?: ((m: string) => void) | undefined }): Promise<KindsDataset> {
  const log = options.log ?? (() => {});
  const perRepo = options.perRepo ?? 8;
  const asOfMs = Date.parse(dataset.asOf);
  const since = new Date(asOfMs - 365 * DAY_MS).toISOString();
  const sources = await createSources({ cachePath: options.cachePath });
  const byKind = emptyCounts();
  const byLanguage: KindsDataset["byLanguage"] = {};
  let sampled = 0;
  let repositories = 0;
  try {
    for (const row of dataset.rows) {
      const [, owner, name] = row.id.split("/") as [string, string, string];
      try {
        const history = await fetchHistory(sources.github, owner, name, { since, asOf: dataset.asOf });
        const merged = history.prs.filter((pr) => !pr.authorIsBot && pr.author && !MAINTAINER_ASSOCIATIONS.has(pr.association) && pr.mergedAt && Date.parse(pr.mergedAt) >= Date.parse(since) && Date.parse(pr.mergedAt) < asOfMs);
        if (merged.length === 0) continue;
        const random = seededRandom((options.seed ?? 1) + repositories);
        const sample = [...merged].map((pr) => ({ pr, r: random() })).sort((a, b) => a.r - b.r).slice(0, perRepo).map((x) => x.pr);
        const files = await fetchPrFiles(sources.github, owner, name, sample.map((pr) => pr.number));
        repositories++;
        byLanguage[row.language] ??= emptyCounts();
        for (const pr of sample) {
          const kind = classifyChange(files.get(pr.number) ?? []);
          if (!kind) continue;
          sampled++;
          const bucket = pr.linkedIssues > 0 ? "withIssue" : "withoutIssue";
          byKind[kind][bucket]++;
          byLanguage[row.language]![kind][bucket]++;
        }
        log(`${row.id}: ${sample.length} of ${merged.length} merged outsider PRs sampled`);
      } catch (error) {
        log(`${row.id}: skipped: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    sources.close();
  }
  return { experiment: "tracker-kinds", asOf: dataset.asOf, fetchedAt: new Date().toISOString(), repositories, sampledPullRequests: sampled, byKind, byLanguage };
}
