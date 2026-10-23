import type { DiscoveryFilters, DiscoveryQuery, RepoFacts } from "@gitgoblin/core";
import type { SearchOptions } from "@gitgoblin/sources";
import { DAY_MS } from "./math.ts";

/** One GitHub search to run. `label` explains the strategy in progress output. */
export interface SearchPlan {
  label: string;
  q: string;
  sort?: SearchOptions["sort"] | undefined;
  order?: SearchOptions["order"] | undefined;
  page?: number | undefined;
  perPage: number;
}

export interface PlanContext {
  now: number;
  /** Facts for `query.seed`, when the user asked for "more like this". */
  seedFacts?: RepoFacts | undefined;
  /** Registry keywords of the seed's packages, used when it has no topics. */
  seedKeywords?: string[] | undefined;
  /** Uniform random in [0, 1) for page selection in the explore goal. */
  random: () => number;
}

const PER_PAGE = 40;
const MAX_LANGUAGES = 3;

function dateAgo(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString().slice(0, 10);
}

function quote(term: string): string {
  const clean = term.replace(/["\\]/g, "").trim();
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

/** Qualifiers every plan shares, derived from the user's filters. */
function baseQualifiers(filters: DiscoveryFilters, now: number): string[] {
  const parts: string[] = [];
  for (const topic of filters.topics ?? []) parts.push(`topic:${quote(topic.toLowerCase())}`);
  for (const keyword of filters.keywords ?? []) parts.push(quote(keyword));
  if (filters.pushedWithinDays) parts.push(`pushed:>${dateAgo(now, filters.pushedWithinDays)}`);
  if (filters.createdWithinDays) parts.push(`created:>${dateAgo(now, filters.createdWithinDays)}`);
  if (filters.licenses?.[0]) parts.push(`license:${filters.licenses[0].toLowerCase()}`);
  if (!filters.includeArchived) parts.push("archived:false");
  if (!filters.includeForks) parts.push("fork:false");
  return parts;
}

function starsQualifier(filters: DiscoveryFilters, defaultMin: number | undefined, defaultMax: number | undefined): string | undefined {
  const min = filters.minStars ?? defaultMin;
  const max = filters.maxStars ?? defaultMax;
  if (min !== undefined && max !== undefined) return `stars:${min}..${max}`;
  if (min !== undefined) return `stars:>=${min}`;
  if (max !== undefined) return `stars:<=${max}`;
  return undefined;
}

interface Variant {
  label: string;
  qualifiers: string[];
  stars: [number | undefined, number | undefined];
  sort?: SearchOptions["sort"] | undefined;
  randomPages?: number | undefined;
}

/** Strategy per goal: several deliberately different slices of GitHub, merged later. */
function goalVariants(query: DiscoveryQuery, now: number, hasUserDateFilter: boolean): Variant[] {
  const recent = (days: number) => (hasUserDateFilter ? [] : [`pushed:>${dateAgo(now, days)}`]);
  switch (query.goal) {
    case "contribute":
      return [
        { label: "starter issues", qualifiers: ["good-first-issues:>0", ...recent(90)], stars: [undefined, undefined], sort: "help-wanted-issues" },
        { label: "help wanted", qualifiers: ["help-wanted-issues:>0", ...recent(60)], stars: [undefined, undefined], sort: "updated" },
        { label: "small and active", qualifiers: recent(30), stars: [10, 800], sort: "updated" },
      ];
    case "learn":
      return [
        { label: "well-known", qualifiers: recent(365), stars: [500, undefined], sort: "stars" },
        { label: "solid but quieter", qualifiers: recent(180), stars: [100, 3000], sort: "stars" },
      ];
    case "adopt":
      return [
        { label: "established", qualifiers: recent(180), stars: [200, undefined], sort: "stars" },
        { label: "recently updated", qualifiers: recent(30), stars: [50, undefined], sort: "updated" },
      ];
    case "revive":
      return [
        { label: "recently gone quiet", qualifiers: hasUserDateFilter ? [] : [`pushed:<${dateAgo(now, 365)}`], stars: [50, 5000], sort: "updated" },
        { label: "long dormant", qualifiers: hasUserDateFilter ? [] : [`pushed:<${dateAgo(now, 730)}`], stars: [200, undefined], sort: "forks" },
        { label: "small but forked", qualifiers: hasUserDateFilter ? [] : [`pushed:<${dateAgo(now, 365)}`], stars: [20, 300], sort: "forks" },
      ];
    case "explore":
      return [
        { label: "tiny and busy", qualifiers: [...recent(30), `created:<${dateAgo(now, 120)}`], stars: [5, 60], sort: "updated", randomPages: 4 },
        { label: "small and busy", qualifiers: recent(14), stars: [30, 400], sort: "updated", randomPages: 3 },
        { label: "new and rising", qualifiers: [`created:>${dateAgo(now, 60)}`], stars: [15, 500], sort: "stars" },
      ];
  }
}

const STOPWORDS = new Set(["with", "that", "this", "from", "your", "into", "using", "based", "simple", "library", "tool", "fast", "small", "easy", "written", "returning", "functions", "multiple"]);

/** Plans for "more like this": the seed's topics, then package keywords, then description words. */
function seedVariants(seed: RepoFacts, seedKeywords: string[]): Variant[] {
  const topics = seed.topics.slice(0, 4).map((t) => `topic:${quote(t)}`);
  const language = seed.language ? [`language:${quote(seed.language)}`] : [];
  const band: [number | undefined, number | undefined] = [Math.max(5, Math.floor(seed.stars / 20)), Math.max(50, seed.stars * 20)];
  const variants: Variant[] = [];
  if (topics.length >= 2) variants.push({ label: "same topics", qualifiers: [...topics.slice(0, 3), ...language], stars: band, sort: "updated" });
  for (const topic of topics.slice(0, 3)) variants.push({ label: `topic ${topic.slice(6)}`, qualifiers: [topic, ...language], stars: band, sort: "stars" });
  if (variants.length > 0) return variants;

  const keywords = [...new Set(seedKeywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 2))].slice(0, 4);
  if (keywords.length > 0) {
    variants.push({ label: "same keywords", qualifiers: [...keywords.slice(0, 3).map(quote), ...language], stars: band, sort: "stars" });
    for (const keyword of keywords.slice(0, 2)) variants.push({ label: `keyword ${keyword}`, qualifiers: [quote(keyword), ...language], stars: band, sort: "updated" });
    return variants;
  }

  const words = (seed.description ?? seed.name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, 3);
  variants.push({ label: "similar description", qualifiers: [...words.map(quote), ...language], stars: band, sort: "stars" });
  return variants;
}

/** Builds the GitHub searches for a query. Each language multiplies the plans. */
export function buildSearchPlans(query: DiscoveryQuery, context: PlanContext): SearchPlan[] {
  const filters = query.filters ?? {};
  const base = baseQualifiers(filters, context.now);
  const hasUserDateFilter = Boolean(filters.pushedWithinDays || filters.createdWithinDays);
  const variants = context.seedFacts ? seedVariants(context.seedFacts, context.seedKeywords ?? []) : goalVariants(query, context.now, hasUserDateFilter);
  const languages = (filters.languages ?? []).slice(0, MAX_LANGUAGES);
  const languageSets = languages.length > 0 ? languages.map((l) => [`language:${quote(l)}`]) : [[]];
  // When the seed already pins a language, do not pin it twice.
  const seedLanguage = context.seedFacts?.language;

  const plans: SearchPlan[] = [];
  for (const variant of variants) {
    for (const languageQualifiers of languageSets) {
      const qualifiers = [...variant.qualifiers, ...base];
      if (!(seedLanguage && languageQualifiers.length === 0)) qualifiers.push(...languageQualifiers);
      const stars = starsQualifier(filters, variant.stars[0], variant.stars[1]);
      if (stars) qualifiers.push(stars);
      const page = variant.randomPages ? 1 + Math.floor(context.random() * variant.randomPages) : 1;
      plans.push({
        label: variant.label,
        q: [...new Set(qualifiers)].join(" "),
        sort: variant.sort,
        order: "desc",
        page,
        perPage: PER_PAGE,
      });
    }
  }
  return plans;
}

/** Facts-only filters applied before any enrichment. Returns a reason to drop, or undefined. */
export function prefilter(facts: RepoFacts, query: DiscoveryQuery, now: number): string | undefined {
  const filters = query.filters ?? {};
  if (facts.archived && !filters.includeArchived && query.goal !== "revive") return "archived";
  if (facts.fork && !filters.includeForks) return "fork";
  if (filters.minStars !== undefined && facts.stars < filters.minStars) return "too few stars";
  if (filters.maxStars !== undefined && facts.stars > filters.maxStars) return "too many stars";
  if (filters.excludeOwners?.some((owner) => owner.toLowerCase() === facts.owner.toLowerCase())) return "excluded owner";
  if (filters.languages?.length && facts.language && !filters.languages.some((l) => l.toLowerCase() === facts.language?.toLowerCase())) {
    return "other language";
  }
  if (filters.licenses?.length && !filters.licenses.some((l) => l.toLowerCase() === facts.license?.toLowerCase())) return "other license";
  if (filters.pushedWithinDays && facts.pushedAt && now - Date.parse(facts.pushedAt) > filters.pushedWithinDays * DAY_MS) return "not pushed recently";
  return undefined;
}
