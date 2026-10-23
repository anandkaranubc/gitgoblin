import { createSources, type Sources, type SourcesOptions } from "@gitgoblin/sources";
import { DiscoveryEngine, type DiscoveryEngineOptions } from "./engine.ts";

export { DiscoveryEngine, type DiscoveryEngineOptions, type ProgressEvent } from "./engine.ts";
export { assessLicense, type LicenseAssessment } from "./license.ts";
export { GOAL_PROFILES, type GoalProfile } from "./profiles.ts";
export { buildSearchPlans, type PlanContext, prefilter, type SearchPlan } from "./queries.ts";
export { diversify } from "./rank.ts";
export { type ScoredRepo, type ScoreOptions, scoreRepo } from "./score.ts";
export { type ComputedSignals, computeSignals } from "./signals.ts";
export type { EcosystemsSource, EnrichedRepo, GitHubSource } from "./types.ts";

export type CreateDiscoveryOptions = SourcesOptions & Pick<DiscoveryEngineOptions, "now" | "onProgress" | "maxPerOwner" | "maxEnriched">;

/** Builds an engine wired to real GitHub and ecosyste.ms clients. Call `sources.close()` when done. */
export async function createDiscovery(options: CreateDiscoveryOptions = {}): Promise<{ engine: DiscoveryEngine; sources: Sources }> {
  const { now, onProgress, maxPerOwner, maxEnriched, ...sourceOptions } = options;
  const sources = await createSources(sourceOptions);
  const engine = new DiscoveryEngine({ github: sources.github, ecosystems: sources.ecosystems, now, onProgress, maxPerOwner, maxEnriched });
  return { engine, sources };
}
