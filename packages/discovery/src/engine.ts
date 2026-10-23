import type { Discoverer, DiscoveryQuery, DiscoveryResult, Goal, RepoFacts, RepoRef } from "@gitgoblin/core";
import { GOALS, isGoal, repoId, sameRepo } from "@gitgoblin/core";
import { seededRandom } from "./math.ts";
import { GOAL_PROFILES } from "./profiles.ts";
import { buildSearchPlans, prefilter } from "./queries.ts";
import { diversify } from "./rank.ts";
import { type ScoredRepo, scoreRepo } from "./score.ts";
import type { EcosystemsSource, EnrichedRepo, GitHubSource } from "./types.ts";

export type ProgressEvent =
  | { stage: "search"; message: string }
  | { stage: "enrich"; message: string }
  | { stage: "score"; message: string }
  | { stage: "warning"; message: string };

export interface DiscoveryEngineOptions {
  github: GitHubSource;
  ecosystems: EcosystemsSource;
  now?: (() => number) | undefined;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
  /** Results per owner before the rest are pushed down. Default 2. */
  maxPerOwner?: number | undefined;
  /** Upper bound on candidates enriched with ecosyste.ms and GraphQL data. Default 48. */
  maxEnriched?: number | undefined;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * The discovery pipeline: search GitHub several ways, drop the obvious misfits,
 * rank cheaply, enrich the promising ones with ecosyste.ms and GraphQL data,
 * rank again with full signals, then spread results across owners.
 */
export class DiscoveryEngine implements Discoverer {
  readonly #github: GitHubSource;
  readonly #ecosystems: EcosystemsSource;
  readonly #now: () => number;
  readonly #progress: (event: ProgressEvent) => void;
  readonly #maxPerOwner: number;
  readonly #maxEnriched: number;

  constructor(options: DiscoveryEngineOptions) {
    this.#github = options.github;
    this.#ecosystems = options.ecosystems;
    this.#now = options.now ?? Date.now;
    this.#progress = options.onProgress ?? (() => {});
    this.#maxPerOwner = options.maxPerOwner ?? 2;
    this.#maxEnriched = options.maxEnriched ?? 48;
  }

  async discover(query: DiscoveryQuery): Promise<DiscoveryResult[]> {
    if (!isGoal(query.goal)) throw new Error(`Unknown goal "${String(query.goal)}". Expected one of: ${GOALS.join(", ")}`);
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const now = this.#now();
    const random = seededRandom(query.randomSeed ?? Math.floor(Math.random() * 2 ** 31));

    const seedFacts = query.seed ? await this.#github.getRepository(query.seed) : undefined;
    if (query.seed && !seedFacts) throw new Error(`Seed repository ${repoId(query.seed)} was not found.`);
    const seedKeywords = seedFacts && seedFacts.topics.length < 2 ? await this.#seedKeywords(seedFacts) : [];

    const candidates = await this.#search(query, { now, seedFacts, seedKeywords, random });

    // Stage one: facts-only ranking decides who deserves the expensive lookups.
    const preliminary = candidates
      .map((facts) => ({ facts, scored: scoreRepo({ facts }, query.goal, { now }) }))
      .filter((c) => !c.scored.excluded)
      .sort((a, b) => b.scored.score - a.scored.score)
      .slice(0, Math.max(limit * 3, Math.min(this.#maxEnriched, 24)))
      .slice(0, this.#maxEnriched);
    this.#progress({ stage: "score", message: `${preliminary.length} of ${candidates.length} candidates kept for enrichment` });

    const enriched = await this.#enrich(preliminary.map((c) => c.facts), query.goal);

    const scored = enriched
      .map((repo) => ({ repo, scored: scoreRepo(repo, query.goal, { now, jitter: query.goal === "explore" ? random() * 2 - 1 : undefined }) }))
      .filter((c) => !c.scored.excluded)
      .sort((a, b) => b.scored.score - a.scored.score || repoId(a.repo.facts).localeCompare(repoId(b.repo.facts)));

    return diversify(scored, (c) => c.repo.facts.owner.toLowerCase(), this.#maxPerOwner)
      .slice(0, limit)
      .map((c) => toResult(c.repo, query.goal, c.scored));
  }

  /** Full signals, evidence and score for one repository. Undefined when it does not exist. */
  async explain(ref: RepoRef, goal: Goal): Promise<DiscoveryResult | undefined> {
    const facts = await this.#github.getRepository(ref);
    if (!facts) return undefined;
    const [repo] = await this.#enrich([facts], "adopt");
    if (!repo) return undefined;
    const scored = scoreRepo(repo, goal, { now: this.#now() });
    return toResult(repo, goal, scored);
  }

  /** Registry keywords of the seed's most-used package, for seeds without GitHub topics. */
  async #seedKeywords(seed: RepoFacts): Promise<string[]> {
    try {
      const packages = await this.#ecosystems.lookupPackages(seed);
      const best = packages.sort((a, b) => b.dependentRepos - a.dependentRepos)[0];
      return best?.keywords ?? [];
    } catch (error) {
      this.#progress({ stage: "warning", message: `seed keywords unavailable: ${errorMessage(error)}` });
      return [];
    }
  }

  async #search(query: DiscoveryQuery, context: { now: number; seedFacts: RepoFacts | undefined; seedKeywords: string[]; random: () => number }): Promise<RepoFacts[]> {
    const plans = buildSearchPlans(query, context);
    const seen = new Map<string, RepoFacts>();
    let failures = 0;
    const results = await Promise.allSettled(
      plans.map(async (plan) => {
        const result = await this.#github.searchRepositories(plan.q, { sort: plan.sort, order: plan.order, page: plan.page, perPage: plan.perPage });
        this.#progress({ stage: "search", message: `${plan.label}: ${result.items.length} of ${result.total} (${plan.q})` });
        return result.items;
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        failures++;
        this.#progress({ stage: "warning", message: `search failed: ${errorMessage(result.reason)}` });
        continue;
      }
      for (const facts of result.value) {
        if (context.seedFacts && sameRepo(facts, context.seedFacts)) continue;
        if (prefilter(facts, query, context.now)) continue;
        const id = repoId(facts);
        if (!seen.has(id)) seen.set(id, facts);
      }
    }
    if (failures === plans.length && plans.length > 0) {
      const first = results.find((r) => r.status === "rejected");
      throw first && first.status === "rejected" ? first.reason : new Error("All searches failed");
    }
    return [...seen.values()];
  }

  /** Fetches the lookups the goal's profile asks for; `explain` passes "adopt" to get everything. */
  async #enrich(candidates: RepoFacts[], goal: Goal): Promise<EnrichedRepo[]> {
    if (candidates.length === 0) return [];
    const wanted = GOAL_PROFILES[goal].enrich;
    this.#progress({ stage: "enrich", message: `looking up ${candidates.length} repositories on ecosyste.ms${this.#github.authenticated ? " and GitHub GraphQL" : ""}` });

    const detailsPromise = this.#github.authenticated
      ? this.#github.repoDetails(candidates).catch((error: unknown) => {
          this.#progress({ stage: "warning", message: `GitHub details unavailable: ${errorMessage(error)}` });
          return new Map();
        })
      : Promise.resolve(new Map());

    const enriched = await Promise.all(
      candidates.map(async (facts): Promise<EnrichedRepo> => {
        const [repo, packages, issues] = await Promise.allSettled([
          this.#ecosystems.lookupRepository(facts),
          wanted.packages ? this.#ecosystems.lookupPackages(facts) : Promise.resolve(undefined),
          wanted.issues ? this.#ecosystems.lookupIssueStats(facts) : Promise.resolve(undefined),
        ]);
        for (const outcome of [repo, packages, issues]) {
          if (outcome.status === "rejected") this.#progress({ stage: "warning", message: `${repoId(facts)}: ${errorMessage(outcome.reason)}` });
        }
        return {
          facts,
          ecosystems: repo.status === "fulfilled" ? repo.value : undefined,
          packages: packages.status === "fulfilled" ? packages.value : undefined,
          issueStats: issues.status === "fulfilled" ? issues.value : undefined,
        };
      }),
    );

    const details = await detailsPromise;
    for (const repo of enriched) repo.details = details.get(repoId(repo.facts));
    return enriched;
  }
}

function toResult(repo: EnrichedRepo, goal: Goal, scored: ScoredRepo): DiscoveryResult {
  const issues = goal === "contribute" ? repo.details?.starterIssueSamples : undefined;
  return {
    repo: repo.facts,
    goal,
    score: scored.score,
    reasons: scored.reasons,
    signals: scored.signals,
    evidence: scored.evidence,
    issues: issues && issues.length > 0 ? issues : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
