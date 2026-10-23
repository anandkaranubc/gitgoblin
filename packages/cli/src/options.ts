import type { DiscoveryFilters, DiscoveryQuery, Goal } from "@gitgoblin/core";
import { GOALS, isGoal, parseRepoRef } from "@gitgoblin/core";

/** Raw option values as commander hands them over. */
export interface DiscoverOptions {
  language?: string[] | undefined;
  topic?: string[] | undefined;
  keyword?: string[] | undefined;
  minStars?: string | undefined;
  maxStars?: string | undefined;
  pushedWithin?: string | undefined;
  createdWithin?: string | undefined;
  license?: string | undefined;
  includeArchived?: boolean | undefined;
  includeForks?: boolean | undefined;
  excludeOwner?: string[] | undefined;
  like?: string | undefined;
  limit?: string | undefined;
  seed?: string | undefined;
}

export function parseGoal(value: string | undefined, fallback: Goal = "explore"): Goal {
  if (value === undefined) return fallback;
  if (isGoal(value)) return value;
  throw new Error(`Unknown goal "${value}". Choose one of: ${GOALS.join(", ")}`);
}

function integer(name: string, value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return n;
}

function list(values: string[] | undefined): string[] | undefined {
  const items = (values ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Turns CLI flags into the engine's query. Pure, so it is easy to test. */
export function toQuery(goal: Goal, options: DiscoverOptions): DiscoveryQuery {
  const filters: DiscoveryFilters = {
    languages: list(options.language),
    topics: list(options.topic),
    keywords: list(options.keyword),
    minStars: integer("min-stars", options.minStars, 0),
    maxStars: integer("max-stars", options.maxStars, 0),
    pushedWithinDays: integer("pushed-within", options.pushedWithin, 1),
    createdWithinDays: integer("created-within", options.createdWithin, 1),
    licenses: options.license ? [options.license] : undefined,
    includeArchived: options.includeArchived,
    includeForks: options.includeForks,
    excludeOwners: list(options.excludeOwner),
  };
  const seed = options.like === undefined ? undefined : parseRepoRef(options.like);
  if (options.like !== undefined && !seed) throw new Error(`--like expects owner/name or a repository URL, got "${options.like}"`);
  return {
    goal,
    filters,
    seed,
    limit: integer("limit", options.limit, 1),
    randomSeed: integer("seed", options.seed, 0),
  };
}
