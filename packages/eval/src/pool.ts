/**
 * Candidate pools pinned to a past date. Discovery's `contribute` slices are
 * reproduced with the push window ending at T, plus a popularity slice (what a
 * star-sorted search would show), so every ranking is compared on the same
 * repositories.
 */
import type { RepoFacts } from "@gitgoblin/core";
import { repoId } from "@gitgoblin/core";
import type { SearchOptions } from "@gitgoblin/sources";
import { seededRandom } from "./metrics.ts";

export interface PoolQuery {
  label: string;
  q: string;
  sort: SearchOptions["sort"];
}

const DAY_MS = 86_400_000;

function day(iso: string, minusDays: number): string {
  return new Date(Date.parse(iso) - minusDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Star bands rather than label slices, created before T and pushed at some
 * point after T minus 180 days. `pushed:A..B` would select repositories whose
 * LAST push fell in the range, which is exactly the set that went quiet after
 * T; the open-ended form is implied by discovery's own 180-day rule for any
 * repository eligible at T, so it adds no survivorship bias.
 */
export const STAR_BANDS: [number, number | undefined][] = [[10, 49], [50, 199], [200, 999], [1000, 4999], [5000, undefined]];

export function poolQueries(language: string, asOf: string): PoolQuery[] {
  const base = `language:"${language}" archived:false fork:false created:<${day(asOf, 90)} pushed:>${day(asOf, 180)}`;
  return STAR_BANDS.map(([lo, hi]) => ({ label: hi === undefined ? `${lo}+ stars` : `${lo}-${hi} stars`, q: `stars:${hi === undefined ? `>=${lo}` : `${lo}..${hi}`} ${base}`, sort: "stars" as const }));
}

export interface PoolMember {
  facts: RepoFacts;
  /** Labels of the search slices that returned this repository. */
  slices: string[];
}

/** Deduplicates and caps a pool with a fixed seed so the sample is reproducible; keeps which slices found each repository. */
export function samplePool(found: { facts: RepoFacts; slice: string }[], cap: number, seed: number): PoolMember[] {
  const unique = new Map<string, PoolMember>();
  for (const { facts, slice } of found) {
    const id = repoId(facts);
    const member = unique.get(id);
    if (member) {
      if (!member.slices.includes(slice)) member.slices.push(slice);
    } else unique.set(id, { facts, slices: [slice] });
  }
  const random = seededRandom(seed);
  return [...unique.values()]
    .sort((a, b) => repoId(a.facts).localeCompare(repoId(b.facts)))
    .map((member) => ({ member, r: random() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, cap)
    .map((x) => x.member);
}
